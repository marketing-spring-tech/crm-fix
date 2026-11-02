import { GLOBAL_PROPERTIES, isExcluded, propertyNames, type EventMapping, type EventsConfig } from "./config.ts";
import { chunks, type HubSpotClient } from "./hubspot.ts";
import { identityKeys, resolveEmail, type NormalizedEvent } from "./mixpanel.ts";
import type { SyncState } from "./state.ts";

export interface SyncOptions {
  /** Create the HubSpot contact if none matches the email (default true) */
  createContacts: boolean;
  /** Also send HubSpot custom behavioral events for mappings with hubspotEventName */
  customEvents: boolean;
  /** Events without an email younger than this are retried next poll (profile $email may land late) */
  emailGraceMs: number;
}

export const DEFAULT_OPTIONS: SyncOptions = { createContacts: true, customEvents: false, emailGraceMs: 30 * 60_000 };

export interface AggregateRow {
  email: string;
  event: string;
  firstAt: string;
  lastAt: string;
  count: number;
  distinctId?: string;
}

export interface SyncStats {
  seen: number;
  excluded: number;
  alreadyProcessed: number;
  synced: number;
  contacts: number;
  notes: number;
  deferredNoEmail: number;
  droppedNoEmail: number;
  droppedNoContact: number;
}

type Props = Record<string, string | null | undefined>;

const earlier = (a: string | null | undefined, b: string) => (a && Date.parse(a) <= Date.parse(b) ? a : b);
const later = (a: string | null | undefined, b: string) => (a && Date.parse(a) >= Date.parse(b) ? a : b);
const num = (v: string | null | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : 0);

/** Property updates for one live event, merged with what HubSpot already has. */
export function computeEventUpdate(
  mapping: EventMapping,
  existing: Props,
  ev: Pick<NormalizedEvent, "timestamp" | "distinctId">,
): Record<string, string> {
  const p = propertyNames(mapping);
  const out: Record<string, string> = {
    [p.firstAt]: earlier(existing[p.firstAt], ev.timestamp),
    [p.lastAt]: later(existing[p.lastAt], ev.timestamp),
    [p.count]: String(num(existing[p.count]) + 1),
    ...mapping.setProperties,
  };
  applyGlobal(out, existing, mapping, ev.timestamp, ev.distinctId);
  return out;
}

/** Property updates from a historical aggregate (backfill). Idempotent: safe to re-run. */
export function computeBackfillUpdate(mapping: EventMapping, existing: Props, row: AggregateRow): Record<string, string> {
  const p = propertyNames(mapping);
  const out: Record<string, string> = {
    [p.firstAt]: earlier(existing[p.firstAt], row.firstAt),
    [p.lastAt]: later(existing[p.lastAt], row.lastAt),
    [p.count]: String(Math.max(num(existing[p.count]), row.count)),
  };
  applyGlobal(out, existing, mapping, row.lastAt, row.distinctId);
  return out;
}

function applyGlobal(out: Record<string, string>, existing: Props, mapping: EventMapping, ts: string, distinctId?: string) {
  const prev = existing[GLOBAL_PROPERTIES.lastActiveAt];
  if (!prev || Date.parse(ts) >= Date.parse(prev)) {
    out[GLOBAL_PROPERTIES.lastActiveAt] = ts;
    out[GLOBAL_PROPERTIES.lastEvent] = mapping.label;
  }
  if (distinctId && !existing[GLOBAL_PROPERTIES.distinctId]) out[GLOBAL_PROPERTIES.distinctId] = distinctId;
}

export function trackedPropertyNames(config: EventsConfig): string[] {
  return [...config.events.flatMap((m) => Object.values(propertyNames(m))), ...Object.values(GLOBAL_PROPERTIES)];
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildNoteBody(mapping: EventMapping, ev: NormalizedEvent, noteProperties: string[]): string {
  const lines = [`<strong>Mixpanel: ${escapeHtml(mapping.label)}</strong>`];
  for (const key of noteProperties) {
    const v = ev.properties[key];
    if (v === undefined || v === null || v === "") continue;
    const text = typeof v === "object" ? JSON.stringify(v) : String(v);
    lines.push(`${escapeHtml(key)}: ${escapeHtml(text.slice(0, 500))}`);
  }
  return lines.join("<br>");
}

export function eventKey(ev: NormalizedEvent): string {
  return ev.insertId ?? `${ev.event}|${ev.distinctId ?? ""}|${ev.timestamp}`;
}

/** Resolves emails for events, using the state's cache first and Mixpanel People for the rest. */
export async function resolveEmails(
  events: NormalizedEvent[],
  state: SyncState,
  lookup: (ids: string[]) => Promise<Map<string, string>>,
): Promise<Map<string, string>> {
  const missing = new Set<string>();
  for (const ev of events) for (const id of identityKeys(ev)) if (!state.emails[id]) missing.add(id);
  if (missing.size) {
    const found = await lookup([...missing]);
    for (const [id, email] of found) state.emails[id] = email;
  }
  return new Map(Object.entries(state.emails));
}

/**
 * Applies new live events to HubSpot. Mutates `state.processed` for every event that was written
 * (or permanently dropped) so overlapping polls never double count.
 */
export async function syncEvents(
  events: NormalizedEvent[],
  config: EventsConfig,
  hubspot: HubSpotClient,
  state: SyncState,
  lookup: (ids: string[]) => Promise<Map<string, string>>,
  options: SyncOptions = DEFAULT_OPTIONS,
  now = Date.now(),
): Promise<SyncStats> {
  const byEvent = new Map(config.events.map((m) => [m.mixpanelEvent, m]));
  const stats: SyncStats = {
    seen: events.length, excluded: 0, alreadyProcessed: 0, synced: 0, contacts: 0, notes: 0,
    deferredNoEmail: 0, droppedNoEmail: 0, droppedNoContact: 0,
  };

  const fresh: NormalizedEvent[] = [];
  const batchKeys = new Set<string>();
  for (const ev of events) {
    const key = eventKey(ev);
    if (byEvent.has(ev.event) && isExcluded(config, ev.properties)) {
      stats.excluded++;
      continue;
    }
    if (!byEvent.has(ev.event) || state.processed[key] !== undefined || batchKeys.has(key)) {
      stats.alreadyProcessed++;
      continue;
    }
    batchKeys.add(key);
    fresh.push(ev);
  }
  if (!fresh.length) return stats;

  const emails = await resolveEmails(fresh, state, lookup);
  const byEmail = new Map<string, NormalizedEvent[]>();
  for (const ev of fresh) {
    const email = resolveEmail(ev, emails);
    if (!email) {
      if (now - ev.processingTimeMs < options.emailGraceMs) stats.deferredNoEmail++;
      else {
        stats.droppedNoEmail++;
        state.processed[eventKey(ev)] = ev.processingTimeMs;
      }
      continue;
    }
    byEmail.set(email, [...(byEmail.get(email) ?? []), ev]);
  }
  if (!byEmail.size) return stats;

  const existing = await hubspot.readContactsByEmail([...byEmail.keys()], trackedPropertyNames(config));
  const upserts: { email: string; properties: Record<string, string> }[] = [];
  const pendingNotes: { email: string; body: string; timestamp: string }[] = [];
  const pendingCustom: { email: string; name: string; timestamp: string }[] = [];
  const writtenByEmail = new Map<string, NormalizedEvent[]>();

  for (const [email, evs] of byEmail) {
    const contact = existing.get(email);
    if (!contact && !options.createContacts) {
      stats.droppedNoContact += evs.length;
      for (const ev of evs) state.processed[eventKey(ev)] = ev.processingTimeMs;
      continue;
    }
    evs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    let merged: Props = { ...(contact?.properties ?? {}) };
    const update: Record<string, string> = {};
    for (const ev of evs) {
      const mapping = byEvent.get(ev.event)!;
      const changes = computeEventUpdate(mapping, merged, ev);
      Object.assign(update, changes);
      merged = { ...merged, ...changes };
      if (mapping.logNote) pendingNotes.push({ email, body: buildNoteBody(mapping, ev, config.noteProperties), timestamp: ev.timestamp });
      if (options.customEvents && mapping.hubspotEventName) pendingCustom.push({ email, name: mapping.hubspotEventName, timestamp: ev.timestamp });
    }
    writtenByEmail.set(email, evs);
    upserts.push({ email, properties: update });
  }

  const idByEmail = new Map([...existing].map(([email, c]) => [email, c.id]));
  for (const chunk of chunks(upserts, 100)) {
    const contacts = await hubspot.upsertContactsByEmail(chunk);
    for (const c of contacts) idByEmail.set(String(c.properties.email ?? "").toLowerCase(), c.id);
    // Counters for this chunk are in HubSpot: mark processed now so a later failure can't double count.
    for (const { email } of chunk) {
      for (const ev of writtenByEmail.get(email)!) state.processed[eventKey(ev)] = ev.processingTimeMs;
      stats.synced += writtenByEmail.get(email)!.length;
    }
    stats.contacts += chunk.length;
  }

  const notes = pendingNotes
    .map((n) => ({ contactId: idByEmail.get(n.email)!, body: n.body, timestamp: n.timestamp }))
    .filter((n) => n.contactId);
  await hubspot.createNotes(notes);
  stats.notes = notes.length;
  for (const c of pendingCustom) await hubspot.sendCustomEvent(c.name, c.email, c.timestamp, {});
  return stats;
}

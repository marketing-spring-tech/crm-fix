import { GLOBAL_PROPERTIES, isExcluded, propertyNames, type EventMapping, type EventsConfig } from "./config.ts";
import type { HubSpotClient } from "./hubspot.ts";
import { userIdOf, type NormalizedEvent } from "./mixpanel.ts";
import type { SyncState } from "./state.ts";

export interface SyncOptions {
  /** Also send HubSpot custom behavioral events for mappings with hubspotEventName */
  customEvents: boolean;
  /**
   * Events whose user has no HubSpot contact yet are retried for this long, in case the
   * sign-up flow writes mixpanel_user_id onto the contact a little after the event.
   */
  matchGraceMs: number;
}

export const DEFAULT_OPTIONS: SyncOptions = { customEvents: false, matchGraceMs: 60 * 60_000 };

export interface AggregateRow {
  userId: string;
  event: string;
  firstAt: string;
  lastAt: string;
  count: number;
}

export interface SyncStats {
  seen: number;
  excluded: number;
  alreadyProcessed: number;
  synced: number;
  contacts: number;
  notes: number;
  anonymous: number;
  deferredNoContact: number;
  droppedNoContact: number;
}

type Props = Record<string, string | null | undefined>;

const earlier = (a: string | null | undefined, b: string) => (a && Date.parse(a) <= Date.parse(b) ? a : b);
const later = (a: string | null | undefined, b: string) => (a && Date.parse(a) >= Date.parse(b) ? a : b);
const num = (v: string | null | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : 0);

/** Property updates for one live event, merged with what HubSpot already has. */
export function computeEventUpdate(mapping: EventMapping, existing: Props, ev: Pick<NormalizedEvent, "timestamp">): Record<string, string> {
  const p = propertyNames(mapping);
  const out: Record<string, string> = {
    [p.firstAt]: earlier(existing[p.firstAt], ev.timestamp),
    [p.lastAt]: later(existing[p.lastAt], ev.timestamp),
    [p.count]: String(num(existing[p.count]) + 1),
    ...mapping.setProperties,
  };
  applyGlobal(out, existing, mapping, ev.timestamp);
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
  applyGlobal(out, existing, mapping, row.lastAt);
  return out;
}

function applyGlobal(out: Record<string, string>, existing: Props, mapping: EventMapping, ts: string) {
  const prev = existing[GLOBAL_PROPERTIES.lastActiveAt];
  if (!prev || Date.parse(ts) >= Date.parse(prev)) {
    out[GLOBAL_PROPERTIES.lastActiveAt] = ts;
    out[GLOBAL_PROPERTIES.lastEvent] = mapping.label;
  }
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

/**
 * Applies new live events to the HubSpot contacts whose mixpanel_user_id matches. Never creates contacts.
 * Records every applied (or permanently dropped) event in `state.processed` so overlapping polls never double count.
 */
export async function syncEvents(
  events: NormalizedEvent[],
  config: EventsConfig,
  hubspot: HubSpotClient,
  state: SyncState,
  options: SyncOptions = DEFAULT_OPTIONS,
  now = Date.now(),
): Promise<SyncStats> {
  const byEvent = new Map(config.events.map((m) => [m.mixpanelEvent, m]));
  const stats: SyncStats = {
    seen: events.length, excluded: 0, alreadyProcessed: 0, synced: 0, contacts: 0, notes: 0,
    anonymous: 0, deferredNoContact: 0, droppedNoContact: 0,
  };
  const markDone = (ev: NormalizedEvent) => (state.processed[eventKey(ev)] = ev.processingTimeMs);

  const byUser = new Map<string, NormalizedEvent[]>();
  const batchKeys = new Set<string>();
  for (const ev of events) {
    const key = eventKey(ev);
    if (!byEvent.has(ev.event) || state.processed[key] !== undefined || batchKeys.has(key)) {
      stats.alreadyProcessed++;
      continue;
    }
    batchKeys.add(key);
    if (isExcluded(config, ev.properties)) {
      stats.excluded++;
      continue;
    }
    const userId = userIdOf(ev);
    if (!userId) {
      stats.anonymous++;
      markDone(ev);
      continue;
    }
    byUser.set(userId, [...(byUser.get(userId) ?? []), ev]);
  }
  if (!byUser.size) return stats;

  const contacts = await hubspot.readContactsBy(GLOBAL_PROPERTIES.userId, [...byUser.keys()], trackedPropertyNames(config));
  const updates: { id: string; properties: Record<string, string>; events: NormalizedEvent[] }[] = [];
  const notes: { contactId: string; body: string; timestamp: string }[] = [];
  const custom: { contactId: string; name: string; timestamp: string }[] = [];

  for (const [userId, evs] of byUser) {
    const contact = contacts.get(userId);
    if (!contact) {
      for (const ev of evs) {
        if (now - ev.processingTimeMs < options.matchGraceMs) stats.deferredNoContact++;
        else {
          stats.droppedNoContact++;
          markDone(ev);
        }
      }
      continue;
    }
    evs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    let merged: Props = { ...contact.properties };
    const properties: Record<string, string> = {};
    for (const ev of evs) {
      const mapping = byEvent.get(ev.event)!;
      const changes = computeEventUpdate(mapping, merged, ev);
      Object.assign(properties, changes);
      merged = { ...merged, ...changes };
      if (mapping.logNote) notes.push({ contactId: contact.id, body: buildNoteBody(mapping, ev, config.noteProperties), timestamp: ev.timestamp });
      if (options.customEvents && mapping.hubspotEventName) custom.push({ contactId: contact.id, name: mapping.hubspotEventName, timestamp: ev.timestamp });
    }
    updates.push({ id: contact.id, properties, events: evs });
  }

  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100);
    await hubspot.updateContacts(chunk.map(({ id, properties }) => ({ id, properties })));
    // Counters for this chunk are in HubSpot: mark processed now so a later failure can't double count.
    for (const u of chunk) {
      u.events.forEach(markDone);
      stats.synced += u.events.length;
    }
    stats.contacts += chunk.length;
  }
  await hubspot.createNotes(notes);
  stats.notes = notes.length;
  for (const c of custom) await hubspot.sendCustomEvent(c.name, c.contactId, c.timestamp);
  return stats;
}

import { GLOBAL_PROPERTIES, propertyNames, type EventMapping, type EventsConfig } from "./config.ts";
import type { Contact, HubSpotClient } from "./hubspot.ts";
import { resolveEmail, type AggregateRow, type NormalizedEvent } from "./posthog.ts";

export type SyncResult =
  | { status: "synced"; email: string; contactId: string; event: string }
  | { status: "ignored"; reason: "untracked_event" | "no_email" | "duplicate" | "contact_missing"; event: string };

export interface SyncOptions {
  /** Create the HubSpot contact if none matches the email (default true) */
  createContacts: boolean;
  /** Also send HubSpot custom behavioral events for mappings with hubspotEventName */
  customEvents: boolean;
}

type Props = Record<string, string | null | undefined>;

const earlier = (a: string | null | undefined, b: string) => (a && Date.parse(a) <= Date.parse(b) ? a : b);
const later = (a: string | null | undefined, b: string) => (a && Date.parse(a) >= Date.parse(b) ? a : b);
const num = (v: string | null | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : 0);

/** Property updates for a single live event, merged with what HubSpot already has. */
export function computeEventUpdate(
  mapping: EventMapping,
  existing: Props,
  ev: Pick<NormalizedEvent, "timestamp" | "distinctId" | "personUrl">,
): Record<string, string> {
  const p = propertyNames(mapping);
  const out: Record<string, string> = {
    [p.firstAt]: earlier(existing[p.firstAt], ev.timestamp),
    [p.lastAt]: later(existing[p.lastAt], ev.timestamp),
    [p.count]: String(num(existing[p.count]) + 1),
    ...mapping.setProperties,
  };
  applyGlobal(out, existing, mapping, ev.timestamp, ev.distinctId, ev.personUrl);
  return out;
}

/** Property updates from a PostHog aggregate row (backfill). Idempotent: safe to re-run. */
export function computeBackfillUpdate(mapping: EventMapping, existing: Props, row: AggregateRow): Record<string, string> {
  const p = propertyNames(mapping);
  const out: Record<string, string> = {
    [p.firstAt]: earlier(existing[p.firstAt], row.firstAt),
    [p.lastAt]: later(existing[p.lastAt], row.lastAt),
    [p.count]: String(Math.max(num(existing[p.count]), row.count)),
  };
  applyGlobal(out, existing, mapping, row.lastAt, row.distinctId, undefined);
  return out;
}

function applyGlobal(
  out: Record<string, string>,
  existing: Props,
  mapping: EventMapping,
  ts: string,
  distinctId: string | undefined,
  personUrl: string | undefined,
) {
  const prev = out[GLOBAL_PROPERTIES.lastActiveAt] ?? existing[GLOBAL_PROPERTIES.lastActiveAt];
  if (!prev || Date.parse(ts) >= Date.parse(prev)) {
    out[GLOBAL_PROPERTIES.lastActiveAt] = ts;
    out[GLOBAL_PROPERTIES.lastEvent] = mapping.label;
  }
  if (distinctId && !existing[GLOBAL_PROPERTIES.distinctId]) out[GLOBAL_PROPERTIES.distinctId] = distinctId;
  if (personUrl) out[GLOBAL_PROPERTIES.personUrl] = personUrl;
}

export function trackedPropertyNames(config: EventsConfig): string[] {
  return [
    ...config.events.flatMap((m) => Object.values(propertyNames(m))),
    ...Object.values(GLOBAL_PROPERTIES),
  ];
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildNoteBody(mapping: EventMapping, ev: NormalizedEvent, noteProperties: string[]): string {
  const lines = [`<strong>PostHog: ${escapeHtml(mapping.label)}</strong>`];
  for (const key of noteProperties) {
    const v = ev.properties[key];
    if (v === undefined || v === null || v === "") continue;
    const text = typeof v === "object" ? JSON.stringify(v) : String(v);
    lines.push(`${escapeHtml(key)}: ${escapeHtml(text.slice(0, 500))}`);
  }
  if (ev.personUrl) lines.push(`<a href="${escapeHtml(ev.personUrl)}">View person in PostHog</a>`);
  return lines.join("<br>");
}

/** Bounded set for de-duplicating PostHog retries by event uuid. */
class RecentIds {
  private readonly ids = new Set<string>();
  constructor(private readonly max = 50_000) {}
  has(id: string) {
    return this.ids.has(id);
  }
  add(id: string) {
    this.ids.add(id);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string);
  }
  delete(id: string) {
    this.ids.delete(id);
  }
}

export class EventSyncer {
  private readonly byEvent: Map<string, EventMapping>;
  private readonly seen = new RecentIds();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly props: string[];

  constructor(
    private readonly config: EventsConfig,
    private readonly hubspot: HubSpotClient,
    private readonly options: SyncOptions = { createContacts: true, customEvents: false },
  ) {
    this.byEvent = new Map(config.events.map((m) => [m.posthogEvent, m]));
    this.props = trackedPropertyNames(config);
  }

  isTracked(eventName: string) {
    return this.byEvent.has(eventName);
  }

  async process(ev: NormalizedEvent): Promise<SyncResult> {
    const mapping = this.byEvent.get(ev.event);
    if (!mapping) return { status: "ignored", reason: "untracked_event", event: ev.event };
    const email = resolveEmail(ev);
    if (!email) return { status: "ignored", reason: "no_email", event: ev.event };
    if (ev.uuid && this.seen.has(ev.uuid)) return { status: "ignored", reason: "duplicate", event: ev.event };
    if (ev.uuid) this.seen.add(ev.uuid);
    try {
      // Serialize per contact so read-modify-write of counters doesn't race inside this process.
      return await this.withLock(email, () => this.apply(mapping, email, ev));
    } catch (err) {
      if (ev.uuid) this.seen.delete(ev.uuid); // allow PostHog's retry to go through
      throw err;
    }
  }

  private async apply(mapping: EventMapping, email: string, ev: NormalizedEvent): Promise<SyncResult> {
    const existing: Contact | null = await this.hubspot.getContactByEmail(email, this.props);
    if (!existing && !this.options.createContacts) {
      return { status: "ignored", reason: "contact_missing", event: ev.event };
    }
    const update = computeEventUpdate(mapping, existing?.properties ?? {}, ev);
    const [contact] = await this.hubspot.upsertContactsByEmail([{ email, properties: update }]);
    const contactId = contact?.id ?? existing?.id;
    if (!contactId) throw new Error(`HubSpot upsert returned no contact for ${email}`);

    if (mapping.logNote) {
      await this.hubspot.createNoteOnContact(contactId, buildNoteBody(mapping, ev, this.config.noteProperties), ev.timestamp);
    }
    if (this.options.customEvents && mapping.hubspotEventName) {
      // Properties are omitted: HubSpot rejects any not pre-defined on the event definition.
      await this.hubspot.sendCustomEvent(mapping.hubspotEventName, email, ev.timestamp, {});
    }
    return { status: "synced", email, contactId, event: ev.event };
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
}

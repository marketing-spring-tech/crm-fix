import { readFileSync } from "node:fs";

export interface EventMapping {
  /** Exact Mixpanel event name, e.g. "Sign Up" */
  mixpanelEvent: string;
  /** Short key used to build HubSpot property names (lowercase, a-z0-9_) */
  key: string;
  /** Human label used for HubSpot property labels and timeline notes */
  label: string;
  /** Add a note to the contact timeline for every occurrence */
  logNote?: boolean;
  /** Static contact properties to write on every occurrence */
  setProperties?: Record<string, string>;
  /** HubSpot custom behavioral event internal name (Enterprise only, e.g. "pe148590905_signed_up") */
  hubspotEventName?: string;
}

export interface EventsConfig {
  events: EventMapping[];
  /** Mixpanel event properties copied into the timeline note body */
  noteProperties: string[];
}

export const PROPERTY_GROUP = "mixpanel";
export const PROPERTY_PREFIX = "mixpanel_";

export function sanitizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function propertyNames(m: EventMapping) {
  const k = sanitizeKey(m.key);
  return {
    firstAt: `${PROPERTY_PREFIX}${k}_first_at`,
    lastAt: `${PROPERTY_PREFIX}${k}_last_at`,
    count: `${PROPERTY_PREFIX}${k}_count`,
  };
}

/** Properties that apply to every tracked event */
export const GLOBAL_PROPERTIES = {
  lastActiveAt: `${PROPERTY_PREFIX}last_tracked_event_at`,
  lastEvent: `${PROPERTY_PREFIX}last_tracked_event`,
  distinctId: `${PROPERTY_PREFIX}distinct_id`,
} as const;

export function parseEventsConfig(raw: unknown): EventsConfig {
  const obj = raw as Partial<EventsConfig>;
  if (!obj || !Array.isArray(obj.events) || obj.events.length === 0) {
    throw new Error("events config must contain a non-empty `events` array");
  }
  const seenEvents = new Set<string>();
  const seenKeys = new Set<string>();
  for (const e of obj.events) {
    if (!e.mixpanelEvent || !e.key || !e.label) {
      throw new Error(`event mapping needs mixpanelEvent, key and label: ${JSON.stringify(e)}`);
    }
    const k = sanitizeKey(e.key);
    if (!k) throw new Error(`invalid key: ${e.key}`);
    // HubSpot property names max out at 100 chars; leave room for prefix/suffix
    if (k.length > 70) throw new Error(`key too long (max 70): ${e.key}`);
    if (seenEvents.has(e.mixpanelEvent)) throw new Error(`duplicate mixpanelEvent: ${e.mixpanelEvent}`);
    if (seenKeys.has(k)) throw new Error(`duplicate key: ${k}`);
    seenEvents.add(e.mixpanelEvent);
    seenKeys.add(k);
  }
  return { events: obj.events, noteProperties: obj.noteProperties ?? [] };
}

export function loadEventsConfig(path = process.env.EVENTS_CONFIG ?? "config/events.json"): EventsConfig {
  return parseEventsConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

import type { FetchFn } from "./hubspot.ts";

export interface NormalizedEvent {
  uuid?: string;
  event: string;
  distinctId?: string;
  timestamp: string;
  properties: Record<string, unknown>;
  personProperties: Record<string, unknown>;
  personUrl?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Accepts the body sent by a PostHog "HTTP Webhook" destination (see README for the template),
 * which looks like { event: { uuid, event, distinct_id, timestamp, properties }, person: { properties, url } }.
 * Also tolerates a flat shape { event: "name", distinct_id, timestamp, properties, person: {...} }.
 */
export function normalizeWebhookPayload(body: unknown): NormalizedEvent {
  const root = asObject(body);
  const evObj = typeof root.event === "object" && root.event !== null ? asObject(root.event) : root;
  const name = asString(evObj.event) ?? asString(evObj.name);
  if (!name) throw new Error("payload has no event name");
  const person = asObject(root.person ?? evObj.person);
  const timestamp = asString(evObj.timestamp) ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`invalid timestamp: ${timestamp}`);
  return {
    uuid: asString(evObj.uuid),
    event: name,
    distinctId: asString(evObj.distinct_id) ?? asString(evObj.distinctId),
    timestamp: new Date(timestamp).toISOString(),
    properties: asObject(evObj.properties),
    personProperties: asObject(person.properties),
    personUrl: asString(person.url),
  };
}

export function resolveEmail(ev: NormalizedEvent): string | undefined {
  const set = asObject(ev.properties.$set);
  const candidates = [
    ev.personProperties.email,
    set.email,
    ev.properties.email,
    ev.properties.$email,
    ev.distinctId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && EMAIL_RE.test(c.trim())) return c.trim().toLowerCase();
  }
  return undefined;
}

export interface AggregateRow {
  email: string;
  event: string;
  firstAt: string;
  lastAt: string;
  count: number;
  distinctId?: string;
}

/** Runs HogQL against the PostHog query API. */
export class PostHogClient {
  constructor(
    private readonly host: string,
    private readonly projectId: string,
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async hogql(query: string): Promise<unknown[][]> {
    const res = await this.fetchFn(`${this.host.replace(/\/$/, "")}/api/projects/${this.projectId}/query/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    });
    if (!res.ok) throw new Error(`PostHog query failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as { results: unknown[][] };
    return json.results;
  }

  /** Per-person, per-event aggregates for the given events, paged. */
  async *aggregates(events: string[], since?: string, pageSize = 10_000): AsyncGenerator<AggregateRow[]> {
    const eventList = events.map((e) => `'${e.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ");
    const sinceClause = since ? `AND timestamp >= toDateTime('${since.replace(/'/g, "")}')` : "";
    for (let offset = 0; ; offset += pageSize) {
      const rows = await this.hogql(`
        SELECT lower(trim(person.properties.email)) AS email, event,
               min(timestamp), max(timestamp), count(), any(distinct_id)
        FROM events
        WHERE event IN (${eventList}) ${sinceClause}
          AND person.properties.email IS NOT NULL AND person.properties.email != ''
        GROUP BY email, event
        ORDER BY email, event
        LIMIT ${pageSize} OFFSET ${offset}`);
      if (rows.length === 0) return;
      yield rows.map((r) => ({
        email: String(r[0]),
        event: String(r[1]),
        firstAt: new Date(String(r[2])).toISOString(),
        lastAt: new Date(String(r[3])).toISOString(),
        count: Number(r[4]),
        distinctId: r[5] == null ? undefined : String(r[5]),
      }));
      if (rows.length < pageSize) return;
    }
  }
}

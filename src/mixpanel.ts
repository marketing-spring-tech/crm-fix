import type { FetchFn } from "./hubspot.ts";

export interface NormalizedEvent {
  insertId?: string;
  event: string;
  distinctId?: string;
  /** Event time, ISO 8601 */
  timestamp: string;
  /** When Mixpanel ingested the event (ms). Used as the incremental cursor. */
  processingTimeMs: number;
  properties: Record<string, unknown>;
}

export type Region = "us" | "eu" | "in";

const HOSTS: Record<Region, { data: string; query: string }> = {
  us: { data: "https://data.mixpanel.com", query: "https://mixpanel.com" },
  eu: { data: "https://data-eu.mixpanel.com", query: "https://eu.mixpanel.com" },
  in: { data: "https://data-in.mixpanel.com", query: "https://in.mixpanel.com" },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(v: unknown): v is string {
  return typeof v === "string" && EMAIL_RE.test(v.trim());
}

/** Converts one line of Mixpanel's raw export into a NormalizedEvent. */
export function normalizeExportEvent(raw: unknown): NormalizedEvent {
  const obj = raw as { event?: unknown; properties?: Record<string, unknown> };
  if (!obj || typeof obj.event !== "string") throw new Error("export row has no event name");
  const p = obj.properties ?? {};
  const timeSec = Number(p.time);
  if (!Number.isFinite(timeSec)) throw new Error(`export row has no valid time: ${JSON.stringify(p.time)}`);
  const timeMs = timeSec > 1e12 ? timeSec : timeSec * 1000; // export returns seconds; tolerate ms
  const processing = Number(p.mp_processing_time_ms);
  return {
    insertId: typeof p.$insert_id === "string" ? p.$insert_id : undefined,
    event: obj.event,
    distinctId: p.distinct_id == null ? undefined : String(p.distinct_id),
    timestamp: new Date(timeMs).toISOString(),
    processingTimeMs: Number.isFinite(processing) ? processing : timeMs,
    properties: p,
  };
}

/** Identity keys to look up in People profiles, most specific first. */
export function identityKeys(ev: NormalizedEvent): string[] {
  const keys = [ev.properties.$user_id, ev.distinctId].filter((v): v is string => typeof v === "string" && v !== "");
  return [...new Set(keys)];
}

/** Email from the event itself (property or an email-shaped id), else from the People profile lookup. */
export function resolveEmail(ev: NormalizedEvent, profileEmails: Map<string, string>): string | undefined {
  const p = ev.properties;
  for (const c of [p.$email, p.email, p.Email]) if (isEmail(c)) return c.trim().toLowerCase();
  for (const id of identityKeys(ev)) {
    const fromProfile = profileEmails.get(id);
    if (fromProfile) return fromProfile;
    if (isEmail(id)) return id.trim().toLowerCase();
  }
  return undefined;
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

export class MixpanelClient {
  private readonly hosts: { data: string; query: string };
  private readonly auth: string;

  constructor(
    username: string,
    secret: string,
    private readonly projectId: string,
    region: Region = "us",
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.hosts = HOSTS[region];
    if (!this.hosts) throw new Error(`unknown MIXPANEL_REGION ${region}`);
    this.auth = "Basic " + Buffer.from(`${username}:${secret}`).toString("base64");
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(url, {
        ...init,
        headers: { Authorization: this.auth, Accept: "application/json", ...(init.headers ?? {}) },
      });
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Mixpanel ${url.split("?")[0]} failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
    }
  }

  /**
   * Yields raw events for the given names between two dates (inclusive, project timezone).
   * Mixpanel sometimes ends an export stream with a plain-text error (e.g. "terminated early") instead of
   * JSON; such a range is split in half down to single days, so one bad day can't block the rest.
   * Export API rate limit: 60 requests/hour, 3/second.
   */
  async *exportEvents(eventNames: string[], from: Date, to: Date): AsyncGenerator<NormalizedEvent> {
    let events: NormalizedEvent[];
    try {
      events = await this.exportRange(eventNames, from, to);
    } catch (err) {
      if (!(err instanceof ExportInterrupted)) throw err;
      const days = Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
      console.error(err.message + (days >= 1 ? " (splitting range)" : ""));
      if (days < 1) throw err;
      const mid = new Date(startOfDay(from) + Math.floor(days / 2) * DAY_MS);
      yield* this.exportEvents(eventNames, from, mid);
      yield* this.exportEvents(eventNames, new Date(mid.getTime() + DAY_MS), to);
      return;
    }
    yield* events;
  }

  private lastExportAt = 0;

  private async exportRange(eventNames: string[], from: Date, to: Date): Promise<NormalizedEvent[]> {
    // Stay under the Export API's 3 requests/second.
    const wait = this.lastExportAt + 400 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastExportAt = Date.now();
    return this.fetchExport(eventNames, from, to);
  }

  private async fetchExport(eventNames: string[], from: Date, to: Date): Promise<NormalizedEvent[]> {
    const qs = new URLSearchParams({
      project_id: this.projectId,
      from_date: fmtDate(from),
      to_date: fmtDate(to),
      event: JSON.stringify(eventNames),
    });
    const res = await this.call(`${this.hosts.data}/api/2.0/export?${qs}`);
    const out: NormalizedEvent[] = [];
    const text = await res.text();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (!line.startsWith("{")) {
        throw new ExportInterrupted(
          `Mixpanel export ${qs.get("from_date")}..${qs.get("to_date")} interrupted: ${line.slice(0, 200)} ` +
            `[status ${res.status}, ${out.length} events before it, request-id ${res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? "n/a"}]`,
        );
      }
      out.push(normalizeExportEvent(JSON.parse(line)));
    }
    return out;
  }

  /** Looks up $email on People profiles. Returns distinct_id -> lowercase email for profiles that have one. */
  async lookupEmails(distinctIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < distinctIds.length; i += 1000) {
      const ids = distinctIds.slice(i, i + 1000);
      let page = 0;
      let sessionId: string | undefined;
      for (;;) {
        const form = new URLSearchParams({
          distinct_ids: JSON.stringify(ids),
          output_properties: JSON.stringify(["$email", "email"]),
        });
        if (sessionId) {
          form.set("session_id", sessionId);
          form.set("page", String(page));
        }
        const res = await this.call(`${this.hosts.query}/api/2.0/engage?project_id=${this.projectId}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        const json = (await res.json()) as {
          results?: { $distinct_id: string; $properties?: Record<string, unknown> }[];
          session_id?: string;
          page_size?: number;
        };
        const results = json.results ?? [];
        for (const r of results) {
          const email = [r.$properties?.$email, r.$properties?.email].find(isEmail);
          if (email) out.set(String(r.$distinct_id), email.trim().toLowerCase());
        }
        if (!json.session_id || results.length < (json.page_size ?? 1000)) break;
        sessionId = json.session_id;
        page++;
      }
    }
    return out;
  }
}

export class ExportInterrupted extends Error {}

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => Date.parse(fmtDate(d));

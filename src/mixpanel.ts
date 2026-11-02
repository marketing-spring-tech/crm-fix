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

/**
 * The Mixpanel user ID used to match HubSpot contacts: $user_id if present, else distinct_id,
 * ignoring anonymous device IDs ("$device:...").
 */
export function userIdOf(ev: NormalizedEvent): string | undefined {
  for (const v of [ev.properties.$user_id, ev.distinctId]) {
    if (typeof v === "string" && v !== "" && !v.startsWith("$device:")) return v;
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
   * Streams raw events for the given names between two dates (inclusive, project timezone).
   * Export API rate limit: 60 requests/hour, 3/second.
   */
  async *exportEvents(eventNames: string[], from: Date, to: Date): AsyncGenerator<NormalizedEvent> {
    const qs = new URLSearchParams({
      project_id: this.projectId,
      from_date: fmtDate(from),
      to_date: fmtDate(to),
      event: JSON.stringify(eventNames),
    });
    const res = await this.call(`${this.hosts.data}/api/2.0/export?${qs}`);
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield normalizeExportEvent(JSON.parse(line));
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield normalizeExportEvent(JSON.parse(buf.trim()));
  }
}

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadEventsConfig, requireEnv } from "./config.ts";
import { HubSpotClient } from "./hubspot.ts";
import { normalizeWebhookPayload } from "./posthog.ts";
import { EventSyncer } from "./sync.ts";

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function authorized(header: string | undefined, secret: string): boolean {
  const token = header?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createHandler(syncer: EventSyncer, secret: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/healthz") return send(res, 200, { ok: true });
    if (req.method !== "POST" || req.url?.split("?")[0] !== "/webhooks/posthog") {
      return send(res, 404, { error: "not found" });
    }
    if (!authorized(req.headers.authorization, secret)) return send(res, 401, { error: "unauthorized" });

    let event;
    try {
      event = normalizeWebhookPayload(JSON.parse(await readBody(req)));
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
    try {
      const result = await syncer.process(event);
      console.log(JSON.stringify({ level: "info", ...result }));
      return send(res, 200, result);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", event: event.event, error: (err as Error).message, detail: (err as { body?: unknown }).body }));
      // 5xx makes PostHog retry the delivery
      return send(res, 502, { error: "sync failed" });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadEventsConfig();
  const hubspot = new HubSpotClient(requireEnv("HUBSPOT_ACCESS_TOKEN"));
  const syncer = new EventSyncer(config, hubspot, {
    createContacts: process.env.CREATE_CONTACTS !== "false",
    customEvents: process.env.HUBSPOT_CUSTOM_EVENTS === "true",
  });
  const port = Number(process.env.PORT ?? 8080);
  createServer(createHandler(syncer, requireEnv("WEBHOOK_SECRET"))).listen(port, () => {
    console.log(`posthog-hubspot-sync listening on :${port}, tracking ${config.events.map((e) => e.posthogEvent).join(", ")}`);
  });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventsConfig, propertyNames, sanitizeKey, type EventsConfig } from "../src/config.ts";
import { HubSpotClient } from "../src/hubspot.ts";
import { normalizeWebhookPayload, resolveEmail } from "../src/posthog.ts";
import { buildNoteBody, computeBackfillUpdate, computeEventUpdate, EventSyncer } from "../src/sync.ts";
import { authorized } from "../src/server.ts";

const config: EventsConfig = parseEventsConfig({
  events: [
    { posthogEvent: "user_signed_up", key: "signed_up", label: "Signed up", logNote: true },
    { posthogEvent: "invite_sent", key: "invite_sent", label: "Teammate invited", setProperties: { is_team_user: "true" } },
  ],
  noteProperties: ["plan"],
});
const signup = config.events[0]!;
const P = propertyNames(signup);

const payload = {
  event: {
    uuid: "u-1",
    event: "user_signed_up",
    distinct_id: "abc",
    timestamp: "2026-10-01T12:00:00Z",
    properties: { plan: "pro <b>", $set: { email: "Jane@Example.com" } },
  },
  person: { properties: {}, url: "https://eu.posthog.com/project/1/person/abc" },
};

test("config validation and key sanitizing", () => {
  assert.equal(sanitizeKey("Signed Up!"), "signed_up");
  assert.deepEqual(P, {
    firstAt: "posthog_signed_up_first_at",
    lastAt: "posthog_signed_up_last_at",
    count: "posthog_signed_up_count",
  });
  assert.throws(() => parseEventsConfig({ events: [] }));
  assert.throws(() =>
    parseEventsConfig({ events: [signup, { ...signup, posthogEvent: "other" }] }),
  /duplicate key/);
});

test("normalizes webhook payload and resolves email", () => {
  const ev = normalizeWebhookPayload(payload);
  assert.equal(ev.event, "user_signed_up");
  assert.equal(ev.timestamp, "2026-10-01T12:00:00.000Z");
  assert.equal(resolveEmail(ev), "jane@example.com");
  // flat payload + stringified properties + email as distinct_id
  const flat = normalizeWebhookPayload({ event: "x", distinct_id: "a@b.io", properties: "{\"k\":1}" });
  assert.equal(resolveEmail(flat), "a@b.io");
  assert.deepEqual(flat.properties, { k: 1 });
  assert.equal(resolveEmail(normalizeWebhookPayload({ event: "x", distinct_id: "anon-123" })), undefined);
  assert.throws(() => normalizeWebhookPayload({ foo: 1 }));
});

test("live update keeps earliest first, latest last, increments count", () => {
  const ev = { timestamp: "2026-10-01T12:00:00.000Z", distinctId: "abc" };
  const fresh = computeEventUpdate(signup, {}, ev);
  assert.equal(fresh[P.firstAt], ev.timestamp);
  assert.equal(fresh[P.count], "1");
  assert.equal(fresh.posthog_last_tracked_event, "Signed up");
  assert.equal(fresh.posthog_distinct_id, "abc");

  const older = computeEventUpdate(signup, {
    [P.firstAt]: "2026-09-01T00:00:00.000Z",
    [P.lastAt]: "2026-11-01T00:00:00.000Z",
    [P.count]: "4",
    posthog_last_tracked_event_at: "2026-11-01T00:00:00.000Z",
    posthog_distinct_id: "abc",
  }, ev);
  assert.equal(older[P.firstAt], "2026-09-01T00:00:00.000Z");
  assert.equal(older[P.lastAt], "2026-11-01T00:00:00.000Z");
  assert.equal(older[P.count], "5");
  assert.equal(older.posthog_last_tracked_event, undefined, "out-of-order event must not move last activity back");
  assert.equal(older.posthog_distinct_id, undefined);

  assert.equal(computeEventUpdate(config.events[1]!, {}, ev).is_team_user, "true");
});

test("backfill update is idempotent", () => {
  const row = { email: "a@b.io", event: "user_signed_up", firstAt: "2026-01-01T00:00:00.000Z", lastAt: "2026-02-01T00:00:00.000Z", count: 3 };
  const once = computeBackfillUpdate(signup, {}, row);
  const twice = computeBackfillUpdate(signup, once, row);
  assert.deepEqual(twice, once);
  assert.equal(twice[P.count], "3");
});

test("note body escapes HTML", () => {
  const body = buildNoteBody(signup, normalizeWebhookPayload(payload), config.noteProperties);
  assert.match(body, /plan: pro &lt;b&gt;/);
  assert.match(body, /View person in PostHog/);
});

test("webhook auth", () => {
  assert.ok(authorized("Bearer s3cret", "s3cret"));
  assert.ok(!authorized("Bearer nope", "s3cret"));
  assert.ok(!authorized(undefined, "s3cret"));
});

function fakeHubSpot() {
  const calls: { method: string; url: string; body: any }[] = [];
  const store = new Map<string, Record<string, string>>();
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), url, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (init.method === "GET") {
      const email = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      const props = store.get(email);
      return props ? json(200, { id: "c-" + email, properties: props }) : json(404, { message: "not found" });
    }
    if (url.endsWith("/batch/upsert")) {
      return json(200, {
        results: body.inputs.map((i: any) => {
          store.set(i.id, { ...(store.get(i.id) ?? {}), ...i.properties });
          return { id: "c-" + i.id, properties: store.get(i.id) };
        }),
      });
    }
    return json(201, {});
  }) as typeof fetch;
  return { client: new HubSpotClient("tok", fetchFn), calls, store };
}

test("syncer upserts contact, logs note, dedupes retries, ignores untracked", async () => {
  const hs = fakeHubSpot();
  const syncer = new EventSyncer(config, hs.client);
  const ev = normalizeWebhookPayload(payload);

  const r1 = await syncer.process(ev);
  assert.equal(r1.status, "synced");
  assert.equal(hs.store.get("jane@example.com")![P.count], "1");
  const note = hs.calls.find((c) => c.url.endsWith("/crm/v3/objects/notes"));
  assert.equal(note?.body.associations[0].to.id, "c-jane@example.com");

  assert.deepEqual(await syncer.process(ev), { status: "ignored", reason: "duplicate", event: "user_signed_up" });
  await syncer.process({ ...ev, uuid: "u-2" });
  assert.equal(hs.store.get("jane@example.com")![P.count], "2");

  assert.equal((await syncer.process({ ...ev, event: "pageview" })).status, "ignored");
});

test("concurrent events for one contact don't lose counts", async () => {
  const hs = fakeHubSpot();
  const syncer = new EventSyncer(config, hs.client);
  const ev = normalizeWebhookPayload(payload);
  await Promise.all([1, 2, 3, 4, 5].map((i) => syncer.process({ ...ev, uuid: `c-${i}` })));
  assert.equal(hs.store.get("jane@example.com")![P.count], "5");
});

test("createContacts=false skips unknown contacts", async () => {
  const hs = fakeHubSpot();
  const syncer = new EventSyncer(config, hs.client, { createContacts: false, customEvents: false });
  const r = await syncer.process(normalizeWebhookPayload(payload));
  assert.deepEqual(r, { status: "ignored", reason: "contact_missing", event: "user_signed_up" });
});

test("client retries 429", async () => {
  let n = 0;
  const fetchFn = (async () => (++n < 2 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response("{\"ok\":1}", { status: 200 }))) as unknown as typeof fetch;
  const res = await new HubSpotClient("t", fetchFn).request<{ ok: number }>("GET", "/x");
  assert.equal(res.ok, 1);
  assert.equal(n, 2);
});

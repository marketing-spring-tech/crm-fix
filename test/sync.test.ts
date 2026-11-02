import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventsConfig, propertyNames, sanitizeKey, type EventsConfig } from "../src/config.ts";
import { HubSpotClient } from "../src/hubspot.ts";
import { MixpanelClient, normalizeExportEvent, resolveEmail } from "../src/mixpanel.ts";
import { emptyState, pruneState } from "../src/state.ts";
import { buildNoteBody, computeBackfillUpdate, computeEventUpdate, syncEvents, DEFAULT_OPTIONS } from "../src/sync.ts";

const config: EventsConfig = parseEventsConfig({
  events: [
    { mixpanelEvent: "Sign Up", key: "signed_up", label: "Signed up", logNote: true },
    { mixpanelEvent: "Invite Sent", key: "invite_sent", label: "Teammate invited", setProperties: { is_team_user: "true" } },
  ],
  noteProperties: ["plan"],
  exclude: { is_internal: [true] },
});
const signup = config.events[0]!;
const P = propertyNames(signup);
const NOW = Date.parse("2026-11-02T12:00:00Z");

function raw(event: string, over: Record<string, unknown> = {}) {
  return {
    event,
    properties: {
      time: Date.parse("2026-11-02T11:20:00Z") / 1000,
      distinct_id: "user-1",
      $insert_id: "ins-" + Math.random(),
      mp_processing_time_ms: NOW - 3_600_000,
      plan: "pro <b>",
      ...over,
    },
  };
}

test("config validation and key sanitizing", () => {
  assert.equal(sanitizeKey("Signed Up!"), "signed_up");
  assert.deepEqual(P, {
    firstAt: "mixpanel_signed_up_first_at",
    lastAt: "mixpanel_signed_up_last_at",
    count: "mixpanel_signed_up_count",
  });
  assert.throws(() => parseEventsConfig({ events: [] }));
  assert.throws(() => parseEventsConfig({ events: [signup, { ...signup, mixpanelEvent: "other" }] }), /duplicate key/);
});

test("normalizes Mixpanel export rows and resolves email", () => {
  const ev = normalizeExportEvent(raw("Sign Up"));
  assert.equal(ev.timestamp, "2026-11-02T11:20:00.000Z");
  assert.equal(ev.processingTimeMs, NOW - 3_600_000);
  assert.equal(resolveEmail(ev, new Map([["user-1", "jane@example.com"]])), "jane@example.com");
  assert.equal(resolveEmail(ev, new Map()), undefined);
  assert.equal(resolveEmail(normalizeExportEvent(raw("x", { $email: "A@B.io" })), new Map()), "a@b.io");
  assert.equal(resolveEmail(normalizeExportEvent(raw("x", { distinct_id: "c@d.io" })), new Map()), "c@d.io");
  assert.equal(
    resolveEmail(normalizeExportEvent(raw("x", { $user_id: "u-9", distinct_id: "$device:1" })), new Map([["u-9", "u9@x.io"]])),
    "u9@x.io",
  );
  assert.throws(() => normalizeExportEvent({ event: "x", properties: {} }));
});

test("live update keeps earliest first, latest last, increments count", () => {
  const ev = { timestamp: "2026-10-01T12:00:00.000Z", distinctId: "abc" };
  const fresh = computeEventUpdate(signup, {}, ev);
  assert.equal(fresh[P.firstAt], ev.timestamp);
  assert.equal(fresh[P.count], "1");
  assert.equal(fresh.mixpanel_last_tracked_event, "Signed up");
  assert.equal(fresh.mixpanel_distinct_id, "abc");

  const older = computeEventUpdate(signup, {
    [P.firstAt]: "2026-09-01T00:00:00.000Z",
    [P.lastAt]: "2026-11-01T00:00:00.000Z",
    [P.count]: "4",
    mixpanel_last_tracked_event_at: "2026-11-01T00:00:00.000Z",
    mixpanel_distinct_id: "abc",
  }, ev);
  assert.equal(older[P.firstAt], "2026-09-01T00:00:00.000Z");
  assert.equal(older[P.lastAt], "2026-11-01T00:00:00.000Z");
  assert.equal(older[P.count], "5");
  assert.equal(older.mixpanel_last_tracked_event, undefined, "out-of-order event must not move last activity back");
  assert.equal(computeEventUpdate(config.events[1]!, {}, ev).is_team_user, "true");
});

test("backfill update is idempotent", () => {
  const row = { email: "a@b.io", event: "Sign Up", firstAt: "2026-01-01T00:00:00.000Z", lastAt: "2026-02-01T00:00:00.000Z", count: 3 };
  const once = computeBackfillUpdate(signup, {}, row);
  assert.deepEqual(computeBackfillUpdate(signup, once, row), once);
});

test("note body escapes HTML", () => {
  assert.match(buildNoteBody(signup, normalizeExportEvent(raw("Sign Up")), config.noteProperties), /plan: pro &lt;b&gt;/);
});

function fakeHubSpot() {
  const calls: { url: string; body: any }[] = [];
  const store = new Map<string, Record<string, string>>();
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (url.endsWith("/batch/read")) {
      return json({
        results: body.inputs.filter((i: any) => store.has(i.id)).map((i: any) => ({ id: "c-" + i.id, properties: { ...store.get(i.id), email: i.id } })),
      });
    }
    if (url.endsWith("/batch/upsert")) {
      return json({
        results: body.inputs.map((i: any) => {
          store.set(i.id, { ...(store.get(i.id) ?? {}), ...i.properties });
          return { id: "c-" + i.id, properties: store.get(i.id) };
        }),
      });
    }
    return json({});
  }) as typeof fetch;
  return { client: new HubSpotClient("tok", fetchFn), calls, store };
}

const lookup = async (ids: string[]) => new Map(ids.filter((i) => i === "user-1").map((i) => [i, "jane@example.com"]));

test("syncEvents writes contacts + notes and never double counts overlapping polls", async () => {
  const hs = fakeHubSpot();
  const state = emptyState();
  const events = [raw("Sign Up"), raw("Invite Sent"), raw("Invite Sent", { time: Date.parse("2026-11-02T11:21:40Z") / 1000 }), raw("Page View")].map(normalizeExportEvent);

  const s1 = await syncEvents(events, config, hs.client, state, lookup, DEFAULT_OPTIONS, NOW);
  assert.equal(s1.synced, 3);
  assert.equal(s1.contacts, 1);
  assert.equal(s1.notes, 1);
  const c = hs.store.get("jane@example.com")!;
  assert.equal(c[P.count], "1");
  assert.equal(c.mixpanel_invite_sent_count, "2");
  assert.equal(c.mixpanel_last_tracked_event, "Teammate invited");
  const note = hs.calls.find((x) => x.url.endsWith("/notes/batch/create"))!;
  assert.equal(note.body.inputs[0].associations[0].to.id, "c-jane@example.com");
  assert.equal(state.emails["user-1"], "jane@example.com");

  // Next poll re-exports the same window plus one new event.
  const s2 = await syncEvents([...events, normalizeExportEvent(raw("Sign Up"))], config, hs.client, state, lookup, DEFAULT_OPTIONS, NOW);
  assert.equal(s2.synced, 1);
  assert.equal(hs.store.get("jane@example.com")![P.count], "2");
  assert.equal(hs.store.get("jane@example.com")!.mixpanel_invite_sent_count, "2");
});

test("events without email are deferred during the grace period, then dropped", async () => {
  const hs = fakeHubSpot();
  const state = emptyState();
  const anon = normalizeExportEvent(raw("Sign Up", { distinct_id: "anon", mp_processing_time_ms: NOW - 60_000 }));
  const s1 = await syncEvents([anon], config, hs.client, state, lookup, DEFAULT_OPTIONS, NOW);
  assert.equal(s1.deferredNoEmail, 1);
  assert.equal(Object.keys(state.processed).length, 0);
  const s2 = await syncEvents([anon], config, hs.client, state, lookup, DEFAULT_OPTIONS, NOW + 3_600_000);
  assert.equal(s2.droppedNoEmail, 1);
  assert.equal(Object.keys(state.processed).length, 1);
});

test("createContacts=false skips unknown contacts", async () => {
  const hs = fakeHubSpot();
  const s = await syncEvents([normalizeExportEvent(raw("Sign Up"))], config, hs.client, emptyState(), lookup, { ...DEFAULT_OPTIONS, createContacts: false }, NOW);
  assert.equal(s.droppedNoContact, 1);
  assert.equal(hs.store.size, 0);
});

test("pruneState drops old keys only", () => {
  const s = emptyState();
  s.processed = { old: 1, recent: NOW };
  pruneState(s, NOW - 1000);
  assert.deepEqual(Object.keys(s.processed), ["recent"]);
});

test("Mixpanel client streams JSONL export and pages engage lookups", async () => {
  const urls: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.match(String((init.headers as Record<string, string>).Authorization), /^Basic /);
    if (url.includes("/export")) {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(JSON.stringify(raw("Sign Up")) + "\n" + JSON.stringify(raw("Sign Up")).slice(0, 10)));
          c.enqueue(enc.encode(JSON.stringify(raw("Sign Up")).slice(10) + "\n"));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }
    return new Response(JSON.stringify({ results: [{ $distinct_id: "user-1", $properties: { $email: "Jane@Example.com" } }], page_size: 1000 }));
  }) as unknown as typeof fetch;
  const mp = new MixpanelClient("u", "s", "42", "eu", fetchFn);
  const out = [];
  for await (const ev of mp.exportEvents(["Sign Up"], new Date("2026-11-01"), new Date("2026-11-02"))) out.push(ev);
  assert.equal(out.length, 2);
  assert.match(urls[0]!, /^https:\/\/data-eu\.mixpanel\.com\/api\/2\.0\/export\?project_id=42&from_date=2026-11-01&to_date=2026-11-02/);
  assert.deepEqual([...(await mp.lookupEmails(["user-1"]))], [["user-1", "jane@example.com"]]);
  assert.match(urls[1]!, /^https:\/\/eu\.mixpanel\.com\/api\/2\.0\/engage\?project_id=42/);
});

test("HubSpot client retries 429", async () => {
  let n = 0;
  const fetchFn = (async () => (++n < 2 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response("{\"ok\":1}", { status: 200 }))) as unknown as typeof fetch;
  assert.equal((await new HubSpotClient("t", fetchFn).request<{ ok: number }>("GET", "/x")).ok, 1);
});

test("excluded (internal) events are skipped", async () => {
  const hs = fakeHubSpot();
  const s = await syncEvents([normalizeExportEvent(raw("Sign Up", { is_internal: true }))], config, hs.client, emptyState(), lookup, DEFAULT_OPTIONS, NOW);
  assert.equal(s.excluded, 1);
  assert.equal(hs.store.size, 0);
});

test("export retries, then splits a range Mixpanel interrupts", async () => {
  const ranges: string[] = [];
  const fetchFn = (async (url: string) => {
    const q = new URL(url).searchParams;
    const range = `${q.get("from_date")}..${q.get("to_date")}`;
    ranges.push(range);
    // The 4-day range and its first half fail; single days succeed.
    if (range === "2026-10-01..2026-10-04" || range === "2026-10-01..2026-10-02") return new Response("terminated early\n");
    return new Response(JSON.stringify(raw("Sign Up", { $insert_id: range })) + "\n");
  }) as unknown as typeof fetch;
  const mp = new MixpanelClient("u", "s", "42", "us", fetchFn);
  const ids = [];
  for await (const ev of mp.exportEvents(["Sign Up"], new Date("2026-10-01"), new Date("2026-10-04"))) ids.push(ev.insertId);
  assert.deepEqual(ids, ["2026-10-01..2026-10-01", "2026-10-02..2026-10-02", "2026-10-03..2026-10-04"]);
  assert.equal(ranges.filter((r) => r === "2026-10-01..2026-10-04").length, 1);
});

test("export gives up on a single day that keeps failing", async () => {
  const fetchFn = (async () => new Response("terminated early")) as unknown as typeof fetch;
  const mp = new MixpanelClient("u", "s", "42", "us", fetchFn);
  await assert.rejects(async () => {
    for await (const _ of mp.exportEvents(["x"], new Date("2026-10-01"), new Date("2026-10-01"))) void _;
  }, /interrupted: terminated early/);
});

test("region is case- and whitespace-insensitive", async () => {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => (urls.push(url), new Response(""))) as unknown as typeof fetch;
  for (const r of ["US", " eu ", "In"]) {
    const mp = new MixpanelClient("u", "s", "1", r, fetchFn);
    for await (const _ of mp.exportEvents(["x"], new Date("2026-11-01"), new Date("2026-11-01"))) void _;
  }
  assert.deepEqual(urls.map((u) => new URL(u).host), ["data.mixpanel.com", "data-eu.mixpanel.com", "data-in.mixpanel.com"]);
  assert.throws(() => new MixpanelClient("u", "s", "1", "mars"), /unknown MIXPANEL_REGION/);
});

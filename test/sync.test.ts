import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventsConfig, propertyNames, sanitizeKey, type EventsConfig } from "../src/config.ts";
import { HubSpotClient } from "../src/hubspot.ts";
import { parseUsersCsv } from "../src/csv.ts";
import { MixpanelClient, normalizeExportEvent, userIdOf } from "../src/mixpanel.ts";
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

test("normalizes Mixpanel export rows and picks the user ID", () => {
  const ev = normalizeExportEvent(raw("Sign Up"));
  assert.equal(ev.timestamp, "2026-11-02T11:20:00.000Z");
  assert.equal(ev.processingTimeMs, NOW - 3_600_000);
  assert.equal(userIdOf(ev), "user-1");
  assert.equal(userIdOf(normalizeExportEvent(raw("x", { $user_id: "u-9", distinct_id: "$device:1" }))), "u-9");
  assert.equal(userIdOf(normalizeExportEvent(raw("x", { distinct_id: "$device:1" }))), undefined);
  assert.throws(() => normalizeExportEvent({ event: "x", properties: {} }));
});

test("parses the users CSV", () => {
  assert.deepEqual(parseUsersCsv('"Email",user_id,name\nJane@X.io,u-1,Jane\nbad,u-2,\nb@y.io,,\n'), [{ email: "jane@x.io", userId: "u-1" }]);
  assert.throws(() => parseUsersCsv("email\na@b.io"));
});

test("live update keeps earliest first, latest last, increments count", () => {
  const ev = { timestamp: "2026-10-01T12:00:00.000Z" };
  const fresh = computeEventUpdate(signup, {}, ev);
  assert.equal(fresh[P.firstAt], ev.timestamp);
  assert.equal(fresh[P.count], "1");
  assert.equal(fresh.mixpanel_last_tracked_event, "Signed up");

  const older = computeEventUpdate(signup, {
    [P.firstAt]: "2026-09-01T00:00:00.000Z",
    [P.lastAt]: "2026-11-01T00:00:00.000Z",
    [P.count]: "4",
    mixpanel_last_tracked_event_at: "2026-11-01T00:00:00.000Z",
  }, ev);
  assert.equal(older[P.firstAt], "2026-09-01T00:00:00.000Z");
  assert.equal(older[P.lastAt], "2026-11-01T00:00:00.000Z");
  assert.equal(older[P.count], "5");
  assert.equal(older.mixpanel_last_tracked_event, undefined, "out-of-order event must not move last activity back");
  assert.equal(computeEventUpdate(config.events[1]!, {}, ev).is_team_user, "true");
});

test("backfill update is idempotent", () => {
  const row = { userId: "u", event: "Sign Up", firstAt: "2026-01-01T00:00:00.000Z", lastAt: "2026-02-01T00:00:00.000Z", count: 3 };
  const once = computeBackfillUpdate(signup, {}, row);
  assert.deepEqual(computeBackfillUpdate(signup, once, row), once);
});

test("note body escapes HTML", () => {
  assert.match(buildNoteBody(signup, normalizeExportEvent(raw("Sign Up")), config.noteProperties), /plan: pro &lt;b&gt;/);
});

function fakeHubSpot(linked: Record<string, string> = { "user-1": "101" }) {
  const calls: { url: string; body: any }[] = [];
  const store = new Map<string, Record<string, string>>(Object.values(linked).map((id) => [id, {}]));
  const idByUser = new Map(Object.entries(linked));
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (url.endsWith("/batch/read")) {
      assert.equal(body.idProperty, "mixpanel_user_id");
      return json({
        results: body.inputs
          .filter((i: any) => idByUser.has(i.id))
          .map((i: any) => ({ id: idByUser.get(i.id), properties: { ...store.get(idByUser.get(i.id)!), mixpanel_user_id: i.id } })),
      });
    }
    if (url.endsWith("/contacts/batch/update")) {
      for (const i of body.inputs) store.set(i.id, { ...store.get(i.id), ...i.properties });
      return json({ results: [] });
    }
    return json({});
  }) as typeof fetch;
  return { client: new HubSpotClient("tok", fetchFn), calls, store };
}

test("syncEvents updates linked contacts + notes and never double counts overlapping polls", async () => {
  const hs = fakeHubSpot();
  const state = emptyState();
  const events = [raw("Sign Up"), raw("Invite Sent"), raw("Invite Sent", { time: Date.parse("2026-11-02T11:21:40Z") / 1000 }), raw("Page View")].map(normalizeExportEvent);

  const s1 = await syncEvents(events, config, hs.client, state, DEFAULT_OPTIONS, NOW);
  assert.equal(s1.synced, 3);
  assert.equal(s1.contacts, 1);
  assert.equal(s1.notes, 1);
  const c = hs.store.get("101")!;
  assert.equal(c[P.count], "1");
  assert.equal(c.mixpanel_invite_sent_count, "2");
  assert.equal(c.mixpanel_last_tracked_event, "Teammate invited");
  assert.equal(c.is_team_user, "true");
  const note = hs.calls.find((x) => x.url.endsWith("/notes/batch/create"))!;
  assert.equal(note.body.inputs[0].associations[0].to.id, "101");

  // Next poll re-exports the same window plus one new event.
  const s2 = await syncEvents([...events, normalizeExportEvent(raw("Sign Up"))], config, hs.client, state, DEFAULT_OPTIONS, NOW);
  assert.equal(s2.synced, 1);
  assert.equal(hs.store.get("101")![P.count], "2");
  assert.equal(hs.store.get("101")!.mixpanel_invite_sent_count, "2");
});

test("unlinked users are retried during the grace period, then dropped; anonymous events dropped", async () => {
  const hs = fakeHubSpot();
  const state = emptyState();
  const unlinked = normalizeExportEvent(raw("Sign Up", { distinct_id: "user-2", mp_processing_time_ms: NOW - 60_000 }));
  const anon = normalizeExportEvent(raw("Sign Up", { distinct_id: "$device:x" }));
  const s1 = await syncEvents([unlinked, anon], config, hs.client, state, DEFAULT_OPTIONS, NOW);
  assert.equal(s1.deferredNoContact, 1);
  assert.equal(s1.anonymous, 1);
  assert.equal(Object.keys(state.processed).length, 1);
  const s2 = await syncEvents([unlinked], config, hs.client, state, DEFAULT_OPTIONS, NOW + 2 * 3_600_000);
  assert.equal(s2.droppedNoContact, 1);
  assert.equal(hs.store.get("101")![P.count], undefined);
});

test("excluded (internal) events are skipped", async () => {
  const hs = fakeHubSpot();
  const s = await syncEvents([normalizeExportEvent(raw("Sign Up", { is_internal: true }))], config, hs.client, emptyState(), DEFAULT_OPTIONS, NOW);
  assert.equal(s.excluded, 1);
  assert.equal(hs.calls.length, 0);
});

test("pruneState drops old keys only", () => {
  const s = emptyState();
  s.processed = { old: 1, recent: NOW };
  pruneState(s, NOW - 1000);
  assert.deepEqual(Object.keys(s.processed), ["recent"]);
});

test("Mixpanel client streams JSONL export", async () => {
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
});

test("HubSpot client retries 429", async () => {
  let n = 0;
  const fetchFn = (async () => (++n < 2 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response("{\"ok\":1}", { status: 200 }))) as unknown as typeof fetch;
  assert.equal((await new HubSpotClient("t", fetchFn).request<{ ok: number }>("GET", "/x")).ok, 1);
});


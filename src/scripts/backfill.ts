/**
 * Loads historical Mixpanel events into HubSpot (first/last/count per event). Idempotent: keeps the earliest
 * first, latest last and larger count, so it can be re-run. Does not create timeline notes.
 * Also marks recent events as processed in the poller's state so the live sync won't count them again.
 *
 *   npm run backfill -- --from 2025-01-01            # default: 365 days ago
 *   npm run backfill -- --from 2025-01-01 --dry-run
 *   npm run backfill -- --existing-only              # never create contacts
 */
import { isExcluded, loadEventsConfig, requireEnv } from "../config.ts";
import { HubSpotClient } from "../hubspot.ts";
import { identityKeys, resolveEmail, type NormalizedEvent } from "../mixpanel.ts";
import { exportRecent, mixpanelFromEnv } from "../run.ts";
import { loadState, saveState } from "../state.ts";
import { computeBackfillUpdate, eventKey, trackedPropertyNames, type AggregateRow } from "../sync.ts";

const DAY = 86_400_000;
const CHUNK_DAYS = 30;
const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes("--dry-run");
const existingOnly = args.includes("--existing-only");
const now = new Date();
const from = new Date(arg("--from") ?? new Date(now.getTime() - 365 * DAY).toISOString().slice(0, 10));
if (Number.isNaN(from.getTime())) throw new Error("--from must be YYYY-MM-DD");

const config = loadEventsConfig();
const byEvent = new Map(config.events.map((m) => [m.mixpanelEvent, m]));
const mixpanel = mixpanelFromEnv();
const hubspot = new HubSpotClient(requireEnv("HUBSPOT_ACCESS_TOKEN"));
const statePath = process.env.STATE_FILE ?? "data/state.json";
const state = loadState(statePath);
const recentCutoff = now.getTime() - (Number(process.env.LOOKBACK_DAYS ?? 2) + 2) * DAY;

// 1. Aggregate per (identity, event). Keep one sample event per identity for email resolution.
const agg = new Map<string, AggregateRow>();
const sample = new Map<string, NormalizedEvent>();
let total = 0;
const recentKeys: [string, number][] = [];
for (let start = from.getTime(); start <= now.getTime(); start += CHUNK_DAYS * DAY) {
  const end = new Date(Math.min(start + (CHUNK_DAYS - 1) * DAY, now.getTime()));
  const events = end.getTime() >= now.getTime() - DAY
    ? await exportRecent(mixpanel, config, new Date(start), now)
    : await collect(new Date(start), end);
  for (const ev of events) {
    if (!byEvent.has(ev.event) || isExcluded(config, ev.properties)) continue;
    total++;
    const id = identityKeys(ev)[0] ?? "";
    sample.set(id, ev);
    const k = `${id}\u0000${ev.event}`;
    const row = agg.get(k);
    if (!row) agg.set(k, { email: id, event: ev.event, firstAt: ev.timestamp, lastAt: ev.timestamp, count: 1, distinctId: ev.distinctId });
    else {
      if (ev.timestamp < row.firstAt) row.firstAt = ev.timestamp;
      if (ev.timestamp > row.lastAt) row.lastAt = ev.timestamp;
      row.count++;
    }
    if (ev.processingTimeMs >= recentCutoff) recentKeys.push([eventKey(ev), ev.processingTimeMs]);
  }
  console.log(`exported through ${end.toISOString().slice(0, 10)}: ${total} tracked events so far`);
}

async function collect(f: Date, t: Date) {
  const out: NormalizedEvent[] = [];
  for await (const ev of mixpanel.exportEvents([...byEvent.keys()], f, t)) out.push(ev);
  return out;
}

// 2. Resolve identities to emails, then merge identities that share an email.
const ids = [...sample.keys()].filter(Boolean);
const profileEmails = await mixpanel.lookupEmails(ids.filter((id) => !state.emails[id]));
for (const [id, email] of profileEmails) state.emails[id] = email;
const emails = new Map(Object.entries(state.emails));
const byEmail = new Map<string, Map<string, AggregateRow>>();
let noEmail = 0;
for (const row of agg.values()) {
  const email = resolveEmail(sample.get(row.email)!, emails);
  if (!email) {
    noEmail += row.count;
    continue;
  }
  const rows = byEmail.get(email) ?? new Map<string, AggregateRow>();
  const prev = rows.get(row.event);
  rows.set(row.event, prev
    ? { ...prev, firstAt: prev.firstAt < row.firstAt ? prev.firstAt : row.firstAt, lastAt: prev.lastAt > row.lastAt ? prev.lastAt : row.lastAt, count: prev.count + row.count }
    : { ...row, email });
  byEmail.set(email, rows);
}
console.log(`${total} events, ${byEmail.size} people with an email, ${noEmail} events without an email skipped`);

// 3. Merge with HubSpot and write.
const existing = await hubspot.readContactsByEmail([...byEmail.keys()], trackedPropertyNames(config));
const upserts: { email: string; properties: Record<string, string> }[] = [];
let skipped = 0;
for (const [email, rows] of byEmail) {
  const contact = existing.get(email);
  if (!contact && existingOnly) {
    skipped++;
    continue;
  }
  let merged: Record<string, string | null> = { ...(contact?.properties ?? {}) };
  const update: Record<string, string> = {};
  for (const row of [...rows.values()].sort((a, b) => a.lastAt.localeCompare(b.lastAt))) {
    const changes = computeBackfillUpdate(byEvent.get(row.event)!, merged, row);
    Object.assign(update, changes);
    merged = { ...merged, ...changes };
  }
  upserts.push({ email, properties: update });
}

if (dryRun) {
  for (const u of upserts.slice(0, 20)) console.log(u.email, u.properties);
  console.log(`[dry run] would write ${upserts.length} contacts (${skipped} skipped, not in HubSpot)`);
} else {
  await hubspot.upsertContactsByEmail(upserts);
  for (const [k, t] of recentKeys) state.processed[k] = t;
  saveState(statePath, state);
  console.log(`wrote ${upserts.length} contacts (${skipped} skipped, not in HubSpot)`);
}

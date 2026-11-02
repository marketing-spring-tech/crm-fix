/**
 * Loads historical Mixpanel events onto HubSpot contacts matched by mixpanel_user_id (first/last/count per event).
 * Idempotent: keeps the earliest first, latest last and larger count, so re-run it after linking more users.
 * Does not create notes or contacts. Also marks recent events as processed in the poller's state so the
 * live sync won't count them again.
 *
 *   npm run backfill -- --from 2025-01-01            # default: 365 days ago
 *   npm run backfill -- --from 2025-01-01 --dry-run
 */
import { GLOBAL_PROPERTIES, isExcluded, loadEventsConfig, requireEnv } from "../config.ts";
import { HubSpotClient } from "../hubspot.ts";
import { userIdOf, type NormalizedEvent } from "../mixpanel.ts";
import { exportRecent, mixpanelFromEnv } from "../run.ts";
import { loadState, saveState } from "../state.ts";
import { computeBackfillUpdate, eventKey, trackedPropertyNames, type AggregateRow } from "../sync.ts";

const DAY = 86_400_000;
const CHUNK_DAYS = 30;
const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes("--dry-run");
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

async function collect(f: Date, t: Date) {
  const out: NormalizedEvent[] = [];
  for await (const ev of mixpanel.exportEvents([...byEvent.keys()], f, t)) out.push(ev);
  return out;
}

// 1. Aggregate per (user, event).
const byUser = new Map<string, Map<string, AggregateRow>>();
const recentKeys: [string, string, number][] = [];
let total = 0;
for (let start = from.getTime(); start <= now.getTime(); start += CHUNK_DAYS * DAY) {
  const end = new Date(Math.min(start + (CHUNK_DAYS - 1) * DAY, now.getTime()));
  const events = end.getTime() >= now.getTime() - DAY
    ? await exportRecent(mixpanel, config, new Date(start), now)
    : await collect(new Date(start), end);
  for (const ev of events) {
    const userId = userIdOf(ev);
    if (!byEvent.has(ev.event) || !userId || isExcluded(config, ev.properties)) continue;
    total++;
    const rows = byUser.get(userId) ?? new Map<string, AggregateRow>();
    const row = rows.get(ev.event);
    if (!row) rows.set(ev.event, { userId, event: ev.event, firstAt: ev.timestamp, lastAt: ev.timestamp, count: 1 });
    else {
      if (ev.timestamp < row.firstAt) row.firstAt = ev.timestamp;
      if (ev.timestamp > row.lastAt) row.lastAt = ev.timestamp;
      row.count++;
    }
    byUser.set(userId, rows);
    if (ev.processingTimeMs >= recentCutoff) recentKeys.push([userId, eventKey(ev), ev.processingTimeMs]);
  }
  console.log(`exported through ${end.toISOString().slice(0, 10)}: ${total} tracked events so far`);
}

// 2. Match to HubSpot contacts and write.
const contacts = await hubspot.readContactsBy(GLOBAL_PROPERTIES.userId, [...byUser.keys()], trackedPropertyNames(config));
const updates: { id: string; properties: Record<string, string> }[] = [];
for (const [userId, rows] of byUser) {
  const contact = contacts.get(userId);
  if (!contact) continue;
  let merged: Record<string, string | null> = { ...contact.properties };
  const properties: Record<string, string> = {};
  for (const row of [...rows.values()].sort((a, b) => a.lastAt.localeCompare(b.lastAt))) {
    const changes = computeBackfillUpdate(byEvent.get(row.event)!, merged, row);
    Object.assign(properties, changes);
    merged = { ...merged, ...changes };
  }
  updates.push({ id: contact.id, properties });
}
const summary = `${total} events from ${byUser.size} users; ${updates.length} users matched a HubSpot contact, ${byUser.size - updates.length} not linked yet`;

if (dryRun) {
  for (const u of updates.slice(0, 20)) console.log(u.id, u.properties);
  console.log(`[dry run] ${summary}`);
} else {
  await hubspot.updateContacts(updates);
  // Only mark recent events of matched users; unmatched ones stay eligible for the live poller.
  for (const [userId, k, t] of recentKeys) if (contacts.has(userId)) state.processed[k] = t;
  saveState(statePath, state);
  console.log(summary);
}

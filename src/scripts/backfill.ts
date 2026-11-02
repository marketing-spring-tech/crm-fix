/**
 * Pulls historical per-person aggregates for every tracked event from PostHog and writes them to HubSpot.
 * Idempotent (takes min/max/max, never double-counts). Does not create timeline notes.
 *
 *   npm run backfill                       # full history, creates missing contacts
 *   npm run backfill -- --since 2026-01-01 # only events since a date
 *   npm run backfill -- --existing-only    # never create contacts
 *   npm run backfill -- --dry-run
 */
import { loadEventsConfig, requireEnv } from "../config.ts";
import { HubSpotClient } from "../hubspot.ts";
import { PostHogClient, type AggregateRow } from "../posthog.ts";
import { computeBackfillUpdate, trackedPropertyNames } from "../sync.ts";

const args = process.argv.slice(2);
const since = args.includes("--since") ? args[args.indexOf("--since") + 1] : undefined;
const dryRun = args.includes("--dry-run");
const existingOnly = args.includes("--existing-only");

const config = loadEventsConfig();
const byEvent = new Map(config.events.map((m) => [m.posthogEvent, m]));
const hubspot = new HubSpotClient(requireEnv("HUBSPOT_ACCESS_TOKEN"));
const posthog = new PostHogClient(
  process.env.POSTHOG_HOST ?? "https://us.posthog.com",
  requireEnv("POSTHOG_PROJECT_ID"),
  requireEnv("POSTHOG_PERSONAL_API_KEY"),
);
const props = trackedPropertyNames(config);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Group rows by email so each contact gets a single write.
const byEmail = new Map<string, AggregateRow[]>();
for await (const page of posthog.aggregates([...byEvent.keys()], since)) {
  for (const row of page) {
    if (!EMAIL_RE.test(row.email)) continue;
    byEmail.set(row.email, [...(byEmail.get(row.email) ?? []), row]);
  }
}
console.log(`PostHog returned ${byEmail.size} people with tracked events`);

let written = 0;
let skipped = 0;
let batch: { email: string; properties: Record<string, string> }[] = [];
const flush = async () => {
  if (!dryRun && batch.length) await hubspot.upsertContactsByEmail(batch);
  written += batch.length;
  batch = [];
};

for (const [email, rows] of byEmail) {
  const contact = await hubspot.getContactByEmail(email, props);
  if (!contact && existingOnly) {
    skipped++;
    continue;
  }
  // Sort by lastAt so the global "last tracked event" ends up on the most recent one.
  rows.sort((a, b) => Date.parse(a.lastAt) - Date.parse(b.lastAt));
  let merged: Record<string, string | null> = { ...(contact?.properties ?? {}) };
  const update: Record<string, string> = {};
  for (const row of rows) {
    const changes = computeBackfillUpdate(byEvent.get(row.event)!, merged, row);
    Object.assign(update, changes);
    merged = { ...merged, ...changes };
  }
  if (dryRun) console.log(email, update);
  batch.push({ email, properties: update });
  if (batch.length === 100) await flush();
}
await flush();
console.log(`${dryRun ? "[dry run] would write" : "wrote"} ${written} contacts, skipped ${skipped} not in HubSpot`);

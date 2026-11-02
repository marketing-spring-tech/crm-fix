/**
 * One-off: writes Mixpanel user IDs onto existing HubSpot contacts, matched by email.
 * Input: a CSV exported from your app database with a header row containing `email` and `user_id`
 * (user_id = the ID your app passes to mixpanel.identify()).
 *
 *   npm run link-users -- users.csv --dry-run
 *   npm run link-users -- users.csv            # only updates contacts that already exist
 *   npm run link-users -- users.csv --create   # also creates contacts for users not in HubSpot
 */
import { readFileSync } from "node:fs";
import { GLOBAL_PROPERTIES, requireEnv } from "../config.ts";
import { parseUsersCsv as parseCsv } from "../csv.ts";
import { HubSpotClient } from "../hubspot.ts";

const [file, ...flags] = process.argv.slice(2);
if (!file) throw new Error("usage: link-users <file.csv> [--dry-run] [--create]");
const dryRun = flags.includes("--dry-run");
const create = flags.includes("--create");
const rows = parseCsv(readFileSync(file, "utf8"));
const hubspot = new HubSpotClient(requireEnv("HUBSPOT_ACCESS_TOKEN"));
const existing = await hubspot.readContactsBy("email", rows.map((r) => r.email), [GLOBAL_PROPERTIES.userId]);

const updates: { id: string; properties: Record<string, string> }[] = [];
const creates: { email: string; properties: Record<string, string> }[] = [];
let unchanged = 0;
for (const r of rows) {
  const c = existing.get(r.email);
  if (c?.properties[GLOBAL_PROPERTIES.userId] === r.userId) unchanged++;
  else if (c) updates.push({ id: c.id, properties: { [GLOBAL_PROPERTIES.userId]: r.userId } });
  else if (create) creates.push({ email: r.email, properties: { [GLOBAL_PROPERTIES.userId]: r.userId } });
}
const notFound = rows.length - updates.length - unchanged - creates.length;
console.log(`${rows.length} users: ${updates.length} to link, ${unchanged} already linked, ${creates.length} to create, ${notFound} not in HubSpot (skipped)`);
if (!dryRun) {
  await hubspot.updateContacts(updates);
  await hubspot.upsertContactsByEmail(creates);
  console.log("done. Now run the backfill to load their history.");
}

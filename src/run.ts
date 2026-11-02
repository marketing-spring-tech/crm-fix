/**
 * Polls Mixpanel's raw export for tracked events and applies new ones to HubSpot.
 *
 *   npm start                 # loop forever, every POLL_INTERVAL_MINUTES
 *   npm start -- --once       # single poll (for cron / scheduled jobs)
 */
import { loadEventsConfig, requireEnv, type EventsConfig } from "./config.ts";
import { HubSpotClient } from "./hubspot.ts";
import { MixpanelClient, type NormalizedEvent, type Region } from "./mixpanel.ts";
import { loadState, pruneState, saveState } from "./state.ts";
import { syncEvents, type SyncOptions } from "./sync.ts";

const DAY = 86_400_000;

export function mixpanelFromEnv(): MixpanelClient {
  return new MixpanelClient(
    requireEnv("MIXPANEL_SERVICE_ACCOUNT_USERNAME"),
    requireEnv("MIXPANEL_SERVICE_ACCOUNT_SECRET"),
    requireEnv("MIXPANEL_PROJECT_ID"),
    (process.env.MIXPANEL_REGION ?? "us") as Region,
  );
}

/**
 * Exports [from, today]. "Today" in UTC can be tomorrow in a US-timezone project, which Mixpanel rejects,
 * so fall back to yesterday-UTC (which then still covers the project's today).
 */
export async function exportRecent(mixpanel: MixpanelClient, config: EventsConfig, from: Date, now: Date) {
  const names = config.events.map((e) => e.mixpanelEvent);
  const collect = async (to: Date) => {
    const out: NormalizedEvent[] = [];
    for await (const ev of mixpanel.exportEvents(names, from, to)) out.push(ev);
    return out;
  };
  try {
    return await collect(now);
  } catch (err) {
    if (!/\(400\)/.test((err as Error).message)) throw err;
    return await collect(new Date(now.getTime() - DAY));
  }
}

async function pollOnce(config: EventsConfig, mixpanel: MixpanelClient, hubspot: HubSpotClient, options: SyncOptions) {
  const statePath = process.env.STATE_FILE ?? "data/state.json";
  const lookbackDays = Number(process.env.LOOKBACK_DAYS ?? 2);
  const now = new Date();
  const state = loadState(statePath);
  const events = await exportRecent(mixpanel, config, new Date(now.getTime() - lookbackDays * DAY), now);
  try {
    const stats = await syncEvents(events, config, hubspot, state, (ids) => mixpanel.lookupEmails(ids), options);
    console.log(JSON.stringify({ level: "info", at: now.toISOString(), ...stats }));
  } finally {
    // Persist progress even on failure so already-written events are never re-counted.
    pruneState(state, now.getTime() - (lookbackDays + 2) * DAY);
    state.lastRunAt = now.toISOString();
    saveState(statePath, state);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadEventsConfig();
  const mixpanel = mixpanelFromEnv();
  const hubspot = new HubSpotClient(requireEnv("HUBSPOT_ACCESS_TOKEN"));
  const options: SyncOptions = {
    createContacts: process.env.CREATE_CONTACTS !== "false",
    customEvents: process.env.HUBSPOT_CUSTOM_EVENTS === "true",
    emailGraceMs: Number(process.env.EMAIL_GRACE_MINUTES ?? 30) * 60_000,
  };
  const intervalMs = Math.max(1, Number(process.env.POLL_INTERVAL_MINUTES ?? 10)) * 60_000;
  console.log(`mixpanel-hubspot-sync tracking: ${config.events.map((e) => e.mixpanelEvent).join(", ")}`);

  if (process.argv.includes("--once")) {
    await pollOnce(config, mixpanel, hubspot, options);
  } else {
    for (;;) {
      try {
        await pollOnce(config, mixpanel, hubspot, options);
      } catch (err) {
        console.error(JSON.stringify({ level: "error", error: (err as Error).message, detail: (err as { body?: unknown }).body }));
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

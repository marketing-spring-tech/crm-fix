# Mixpanel → HubSpot sync

This service puts your key Mixpanel product events onto HubSpot contacts, so sales and marketing can see product usage in HubSpot and use it for lists, workflows, lead scoring and reports.

```
Mixpanel Export API ──(poll every 10 min)──▶ resolve email (event / People profile) ──▶ HubSpot contact
                                                                                        ├─ mixpanel_<event>_first_at / _last_at / _count
                                                                                        ├─ mixpanel_last_tracked_event(_at), mixpanel_distinct_id
                                                                                        ├─ timeline note (optional, per event)
                                                                                        └─ custom behavioral event (optional, Enterprise)
```

Mixpanel can't push individual events to a webhook. Its built-in HubSpot integration only syncs **cohorts**. So this service **polls** Mixpanel's raw Export API every few minutes. Each poll:

1. Exports the tracked events from the last `LOOKBACK_DAYS` (default 2). The overlap catches events that reach Mixpanel late, such as from offline mobile devices or batch imports.
2. Skips events it has already applied, keyed on Mixpanel's `$insert_id`, so overlapping polls never double-count.
3. Finds each person's email. It checks the event's `$email`/`email` property, then the `$email` on the People profile for `$user_id`/`distinct_id`, then a `distinct_id` that is itself an email. Events with no email are retried for `EMAIL_GRACE_MINUTES` (default 30), in case `people.set` lands after the event, and then skipped.
4. Upserts each HubSpot contact by email, creating it unless `CREATE_CONTACTS=false`. It updates the first-seen, last-seen and count properties for each event. If `logNote` is set, it also adds a timeline note.

All properties go in a **Mixpanel** property group on the contact record. Expect events in HubSpot within about one poll interval.

## Which events

The events are set in [`config/events.json`](config/events.json). **The defaults are placeholders.** Replace them with your real Mixpanel event names (Data Management → Lexicon):

| field | meaning |
|---|---|
| `mixpanelEvent` | exact Mixpanel event name (case-sensitive) |
| `key` | short name used in HubSpot property names (`mixpanel_<key>_first_at`, …) |
| `label` | readable name for property labels and timeline notes |
| `logNote` | `true` adds a timeline note for each occurrence. Use it for high-signal, low-volume events only. |
| `setProperties` | optional static contact properties to set, e.g. `{"customer_type": "self_serve"}` |
| `hubspotEventName` | optional HubSpot custom behavioral event name. Only used when `HUBSPOT_CUSTOM_EVENTS=true`, which needs Marketing Hub Enterprise. |

`noteProperties` lists the Mixpanel event properties to copy into the note text.

## Setup

### 1. Credentials
- **HubSpot**: go to Settings → Integrations → Private Apps → Create. Add these scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`, `crm.schemas.contacts.write`.
- **Mixpanel**: go to Organization Settings → Service Accounts. Create one with the Analyst role (or higher) on the project. Note the project ID and data region (US, EU or IN).

```bash
npm install
```
```bash
cp .env.example .env   # fill in values
```

### 2. Create the HubSpot properties
```bash
node --env-file=.env --import tsx src/scripts/setup-properties.ts
```
You can safely run this again after you add events to the config.

### 3. Backfill history (one-off, optional)
```bash
node --env-file=.env --import tsx src/scripts/backfill.ts --from 2025-01-01 --dry-run
```
```bash
node --env-file=.env --import tsx src/scripts/backfill.ts --from 2025-01-01
```
The backfill can be re-run safely: it keeps the earliest first-seen, the latest last-seen and the larger count. It does not create timeline notes. It also records recent events in the state file, so the live poller won't count them again. Use the same `STATE_FILE` as the poller. `--existing-only` only updates contacts already in HubSpot.

### 4. Run the poller
You can run it as a long-lived worker:
```bash
docker build -t mixpanel-hubspot-sync .
```
```bash
docker run -d --env-file .env -v mixpanel-sync-data:/app/data mixpanel-hubspot-sync
```
Or run a single poll from cron or a scheduled job (Cloud Run Jobs, ECS scheduled task, etc.):
```bash
node --env-file=.env --import tsx src/run.ts --once
```
The state file (`STATE_FILE`, default `data/state.json`) stores which events were already applied and an email cache. **It must persist between runs**, and only **one** poller should run at a time.

Mixpanel's Export API allows 60 requests per hour. One poll every 10 minutes uses 6.

## Using it in HubSpot
- **Lists / segments**: e.g. "Mixpanel: Signed up (first) is known AND Mixpanel: Onboarding completed (first) is unknown" finds people who signed up but never onboarded.
- **Workflows**: trigger when `Mixpanel: Subscription started (first)` becomes known, then set the lifecycle stage to Customer and notify the owner.
- **Lead scoring**: add points for `Mixpanel: Teammate invited (count)` > 0.
- **Reports**: use the Mixpanel properties in any contact report.

## Limitations
- Events are matched to contacts by email only. Anonymous events that are never tied to a profile with an email are skipped.
- The Export API returns `distinct_id` exactly as it was sent. Events tracked before `identify()` keep the device ID, so they only match if the event carries `$user_id` or an email property.

## Development
```bash
npm test
```
```bash
npm run typecheck
```

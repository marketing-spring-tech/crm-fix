# Mixpanel → HubSpot sync

This service puts the key product events from the Mixpanel project **Spring (4058092)** onto HubSpot contacts, so sales and marketing can see product usage in HubSpot and use it for lists, workflows, lead scoring and reports.

```
Mixpanel Export API ──(poll every 10 min)──▶ match on Mixpanel user ID ──▶ HubSpot contact (mixpanel_user_id)
                                                                           ├─ mixpanel_<event>_first_at / _last_at / _count
                                                                           ├─ mixpanel_last_tracked_event(_at)
                                                                           ├─ timeline note (milestone events)
                                                                           └─ custom behavioral event (optional, Enterprise)
```

## How matching works

Mixpanel has no email address for Spring users, only the user ID the app passes to `mixpanel.identify()`. So contacts are matched on a HubSpot contact property, **`mixpanel_user_id`**. It is a unique-value property, and it holds that same ID.

That ID gets onto a contact in two ways:

1. **New sign-ups (ongoing):** wherever your backend or sign-up flow creates or updates the HubSpot contact, also set `mixpanel_user_id` to the user's ID. Through the API that's one more property on the contact. With a HubSpot form, add a hidden `mixpanel_user_id` field.
2. **Existing users (one-off):** export `email,user_id` from your app database and run `link-users` (see below).

The sync **never creates contacts**. Events from users not linked to a contact are retried for `MATCH_GRACE_MINUTES` (default 60, so a sign-up flow that writes the ID a bit late still gets picked up), and then skipped. Running the backfill again loads any skipped history once more users are linked.

## How the sync works

Mixpanel can't push individual events to a webhook. Its built-in HubSpot integration only syncs **cohorts**. So this service **polls** Mixpanel's raw Export API every few minutes. Each poll:

1. Exports the tracked events from the last `LOOKBACK_DAYS` (default 2), so events that arrive late are still caught.
2. Skips events it has already applied, keyed on Mixpanel's `$insert_id`, so overlapping polls never double-count. It also skips excluded events (internal users, `dev` builds) and anonymous events (device IDs only).
3. Looks contacts up by `mixpanel_user_id` and updates the first-seen, last-seen and count properties for each event. Milestone events also get a timeline note.

All properties go in a **Mixpanel** property group on the contact record. Expect events in HubSpot within about one poll interval.

## Tracked events

The events are set in [`config/events.json`](config/events.json):

| Area | Mixpanel events | Timeline note |
|---|---|---|
| Acquisition | `app_installed`, `account_created` | ✓ |
| Onboarding / activation | `onboarding_started`, `onboarding_first_result_shown`, `onboarding_finished` | first result, finished |
| Usage / retention | `app_opened`, `project_created`, `project_opened`, `prompt_sent`, `change_kept` | – |
| Integrations | `github_connected`, `connector_connected`, `pr_merged` | GitHub, PR merged |
| Sharing / team | `share_published`, `team_invite_sent`, `team_invite_accepted` | ✓ |
| Upgrade signal | `credit_cap_reached` | ✓ |

Events with `is_internal = true` or `app_env = dev` are excluded.

| field | meaning |
|---|---|
| `mixpanelEvent` | exact Mixpanel event name (case-sensitive) |
| `key` | short name used in HubSpot property names (`mixpanel_<key>_first_at`, …) |
| `label` | readable name for property labels and timeline notes |
| `logNote` | `true` adds a timeline note for each occurrence |
| `setProperties` | optional static contact properties to set on each occurrence |
| `hubspotEventName` | optional HubSpot custom behavioral event name. Only used when `HUBSPOT_CUSTOM_EVENTS=true`, which needs Marketing Hub Enterprise. |

`noteProperties` lists the event properties copied into notes. `exclude` skips events whose property matches one of the listed values.

## Setup

### 1. Credentials
- **HubSpot**: go to Settings → Integrations → Private Apps → Create. Add these scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`, `crm.schemas.contacts.write`.
- **Mixpanel**: go to Organization Settings → Service Accounts. Create one with the Analyst role (or higher) on project 4058092, and note the data region (US, EU or IN).

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
You can safely run this again after you add events.

### 3. Link existing users
Export a CSV from your app database with the columns `email,user_id`, then:
```bash
node --env-file=.env --import tsx src/scripts/link-users.ts users.csv --dry-run
```
```bash
node --env-file=.env --import tsx src/scripts/link-users.ts users.csv
```
By default it only links contacts already in HubSpot. Add `--create` to also create contacts for app users who aren't in HubSpot yet.

### 4. Backfill history
```bash
node --env-file=.env --import tsx src/scripts/backfill.ts --from 2025-01-01 --dry-run
```
```bash
node --env-file=.env --import tsx src/scripts/backfill.ts --from 2025-01-01
```
The backfill can be re-run safely, e.g. after linking more users: it keeps the earliest first-seen, the latest last-seen and the larger count. It doesn't create notes. Use the same `STATE_FILE` as the poller, so recent events aren't counted again.

### 5. Run the poller
You can run it as a long-lived worker:
```bash
docker build -t mixpanel-hubspot-sync .
```
```bash
docker run -d --env-file .env -v mixpanel-sync-data:/app/data mixpanel-hubspot-sync
```
Or run a single poll from a scheduler:
```bash
node --env-file=.env --import tsx src/run.ts --once
```
The state file (`STATE_FILE`) must persist between runs, and only **one** poller should run at a time. Mixpanel's Export API allows 60 requests per hour. One poll every 10 minutes uses 6.

## Using it in HubSpot
- **Activation**: "Mixpanel: Account created (first) is known AND Mixpanel: First result shown (first) is unknown" finds people who signed up but haven't reached their first win.
- **Upgrade signal**: a workflow on `Mixpanel: Credit cap reached (first)` becoming known can notify the owner or enroll the contact in an upgrade sequence.
- **Retention**: filter on `Mixpanel: App opened (last)` before 14 days ago to find users at risk of churning.
- **Lead scoring**: give points for `Mixpanel: GitHub connected`, `Mixpanel: Teammate invited (count)` and `Mixpanel: Prompt sent (count)`.

## Development
```bash
npm test
```
```bash
npm run typecheck
```

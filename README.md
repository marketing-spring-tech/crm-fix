# PostHog → HubSpot sync

This service moves your key PostHog product events onto HubSpot contacts in real time, so sales and marketing can see product usage in HubSpot and use it for lists, workflows, lead scoring and reports.

```
PostHog event ──(HTTP Webhook destination)──▶ /webhooks/posthog ──▶ HubSpot contact
                                                                      ├─ posthog_<event>_first_at / _last_at / _count
                                                                      ├─ posthog_last_tracked_event(_at), distinct_id, person_url
                                                                      ├─ timeline note (optional, per event)
                                                                      └─ custom behavioral event (optional, Enterprise)
```

For each tracked event it:

1. Finds the person's email: PostHog person `email`, then `$set.email`, then event `email`, then a `distinct_id` that is an email. Events with no email are skipped.
2. Upserts the HubSpot contact by email, creating it unless `CREATE_CONTACTS=false`.
3. Updates the first-seen, last-seen and count properties for that event. Events that arrive out of order or are retried are handled correctly. Retries are de-duplicated on the PostHog event `uuid`.
4. If `logNote` is set, adds a note to the contact timeline, for example "PostHog: Subscription started, plan: pro".

All properties go in a **PostHog** property group on the contact record.

## Which events

The events are set in [`config/events.json`](config/events.json). **The defaults are placeholders.** Replace them with the real event names from PostHog (Activity → Events):

| field | meaning |
|---|---|
| `posthogEvent` | exact PostHog event name |
| `key` | short name used in HubSpot property names (`posthog_<key>_first_at`, …) |
| `label` | readable name for property labels and timeline notes |
| `logNote` | `true` adds a timeline note for each occurrence. Use it for high-signal, low-volume events only. |
| `setProperties` | optional static contact properties to set, e.g. `{"customer_type": "self_serve"}` |
| `hubspotEventName` | optional HubSpot custom behavioral event name. Only used when `HUBSPOT_CUSTOM_EVENTS=true`, which needs Marketing Hub Enterprise. |

`noteProperties` lists the PostHog event properties to copy into the note text.

## Setup

### 1. HubSpot private app
In HubSpot, go to Settings → Integrations → Private Apps → Create. Add these scopes:
`crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`, `crm.schemas.contacts.write`.
Copy the token into `HUBSPOT_ACCESS_TOKEN` (see `.env.example`).

### 2. Create the HubSpot properties
```bash
npm install
```
```bash
cp .env.example .env   # fill in values
```
```bash
node --env-file=.env --import tsx src/scripts/setup-properties.ts
```
You can safely run this again after you add events to the config.

### 3. Deploy the webhook
Run it on anything that runs Docker or Node 20+, such as Render, Fly, Railway, Cloud Run or ECS:
```bash
docker build -t posthog-hubspot-sync .
```
```bash
docker run -p 8080:8080 --env-file .env posthog-hubspot-sync
```
Endpoints: `POST /webhooks/posthog` (needs `Authorization: Bearer $WEBHOOK_SECRET`) and `GET /healthz`.

The service counts events by reading the contact and then writing it back, with writes for the same contact done one at a time. Run **a single instance** so counts stay exact. Timestamps are always correct with any number of instances.

### 4. PostHog destination
In PostHog, go to Data pipelines → Destinations → New destination → **HTTP Webhook**:

- **URL**: `https://<your-host>/webhooks/posthog`
- **Method**: POST
- **Headers**: `Authorization: Bearer <WEBHOOK_SECRET>`
- **JSON body**:
  ```json
  {
    "event": {
      "uuid": "{event.uuid}",
      "event": "{event.event}",
      "distinct_id": "{event.distinct_id}",
      "timestamp": "{event.timestamp}",
      "properties": "{event.properties}"
    },
    "person": {
      "properties": "{person.properties}",
      "url": "{person.url}"
    }
  }
  ```
- **Filters**: add each event from `config/events.json`. The service ignores any other event, but filtering here saves invocations.

### 5. Backfill history (one-off)
Create a PostHog personal API key with `query:read`, then set `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` and `POSTHOG_HOST`:
```bash
node --env-file=.env --import tsx src/scripts/backfill.ts --dry-run
```
```bash
node --env-file=.env --import tsx src/scripts/backfill.ts
```
Options: `--since 2026-01-01` limits the date range. `--existing-only` only updates contacts already in HubSpot. The backfill can be re-run safely: it keeps the earliest first-seen, the latest last-seen and the larger count. It does not create timeline notes.

## Using it in HubSpot
- **Lists / segments**: e.g. "PostHog: Signed up (first) is known AND PostHog: Onboarding completed (first) is unknown" finds people who signed up but never onboarded.
- **Workflows**: trigger when `PostHog: Subscription started (first)` becomes known, then set the lifecycle stage to Customer and notify the owner.
- **Lead scoring**: add points for `PostHog: Teammate invited (count)` > 0.
- **Reports**: use the PostHog properties in any contact report.

## Development
```bash
npm test
```
```bash
npm run typecheck
```

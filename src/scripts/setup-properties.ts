/** Creates the "PostHog" contact property group and one set of properties per tracked event. Idempotent. */
import { GLOBAL_PROPERTIES, PROPERTY_GROUP, loadEventsConfig, propertyNames, requireEnv } from "../config.ts";
import { HubSpotClient } from "../hubspot.ts";

const config = loadEventsConfig();
const hubspot = new HubSpotClient(requireEnv("HUBSPOT_ACCESS_TOKEN"));

console.log(`property group "${PROPERTY_GROUP}": ${await hubspot.ensurePropertyGroup(PROPERTY_GROUP, "PostHog")}`);

type Def = Parameters<HubSpotClient["ensureProperty"]>[0];
const defs: Def[] = [
  { name: GLOBAL_PROPERTIES.lastActiveAt, label: "PostHog: last tracked event at", type: "datetime", fieldType: "date", groupName: PROPERTY_GROUP },
  { name: GLOBAL_PROPERTIES.lastEvent, label: "PostHog: last tracked event", type: "string", fieldType: "text", groupName: PROPERTY_GROUP },
  { name: GLOBAL_PROPERTIES.distinctId, label: "PostHog: distinct ID", type: "string", fieldType: "text", groupName: PROPERTY_GROUP },
  { name: GLOBAL_PROPERTIES.personUrl, label: "PostHog: person URL", type: "string", fieldType: "text", groupName: PROPERTY_GROUP },
];
for (const m of config.events) {
  const p = propertyNames(m);
  const description = `Synced from PostHog event "${m.posthogEvent}"`;
  defs.push(
    { name: p.firstAt, label: `PostHog: ${m.label} (first)`, type: "datetime", fieldType: "date", groupName: PROPERTY_GROUP, description },
    { name: p.lastAt, label: `PostHog: ${m.label} (last)`, type: "datetime", fieldType: "date", groupName: PROPERTY_GROUP, description },
    { name: p.count, label: `PostHog: ${m.label} (count)`, type: "number", fieldType: "number", groupName: PROPERTY_GROUP, description },
  );
}
for (const d of defs) console.log(`${d.name}: ${await hubspot.ensureProperty(d)}`);

/** Creates the "Mixpanel" contact property group and one set of properties per tracked event. Idempotent. */
import { GLOBAL_PROPERTIES, PROPERTY_GROUP, loadEventsConfig, propertyNames, requireEnv } from "../config.ts";
import { HubSpotClient } from "../hubspot.ts";

const config = loadEventsConfig();
const hubspot = new HubSpotClient(requireEnv("HUBSPOT_ACCESS_TOKEN"));

console.log(`property group "${PROPERTY_GROUP}": ${await hubspot.ensurePropertyGroup(PROPERTY_GROUP, "Mixpanel")}`);

type Def = Parameters<HubSpotClient["ensureProperty"]>[0];
const defs: Def[] = [
  { name: GLOBAL_PROPERTIES.lastActiveAt, label: "Mixpanel: last tracked event at", type: "datetime", fieldType: "date", groupName: PROPERTY_GROUP },
  { name: GLOBAL_PROPERTIES.lastEvent, label: "Mixpanel: last tracked event", type: "string", fieldType: "text", groupName: PROPERTY_GROUP },
  { name: GLOBAL_PROPERTIES.distinctId, label: "Mixpanel: distinct ID", type: "string", fieldType: "text", groupName: PROPERTY_GROUP },
];
for (const m of config.events) {
  const p = propertyNames(m);
  const description = `Synced from Mixpanel event "${m.mixpanelEvent}"`;
  defs.push(
    { name: p.firstAt, label: `Mixpanel: ${m.label} (first)`, type: "datetime", fieldType: "date", groupName: PROPERTY_GROUP, description },
    { name: p.lastAt, label: `Mixpanel: ${m.label} (last)`, type: "datetime", fieldType: "date", groupName: PROPERTY_GROUP, description },
    { name: p.count, label: `Mixpanel: ${m.label} (count)`, type: "number", fieldType: "number", groupName: PROPERTY_GROUP, description },
  );
}
for (const d of defs) console.log(`${d.name}: ${await hubspot.ensureProperty(d)}`);

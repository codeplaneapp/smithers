import { readFileSync } from "node:fs";
import type { FleetSubscriptionRecord } from "./FleetSubscriptionRecord";
import { fleetManifestPath } from "./fleetManifestPath";

/** Read the fleet subscription manifest (empty if it doesn't exist yet). */
export function readFleetSubscriptions(): FleetSubscriptionRecord[] {
  let raw: string;
  try {
    raw = readFileSync(fleetManifestPath(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { subscriptions?: FleetSubscriptionRecord[] };
    return Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
  } catch {
    return [];
  }
}

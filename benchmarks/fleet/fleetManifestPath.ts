import { homedir } from "node:os";
import { join } from "node:path";

/** Path to the fleet subscription manifest, honoring `SMITHERS_HOME`. */
export function fleetManifestPath(): string {
  const root = process.env.SMITHERS_HOME?.trim() || join(homedir(), ".smithers");
  return join(root, "fleet", "subscriptions.json");
}

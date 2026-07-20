import { homedir } from "node:os";
import { join } from "node:path";

/** The per-account Claude config dir the fleet uses for a given account label. */
export function fleetAccountConfigDir(label: string): string {
  const root = process.env.SMITHERS_HOME?.trim() || join(homedir(), ".smithers");
  return join(root, "accounts", label);
}

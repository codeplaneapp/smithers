import { join } from "node:path";
import { accountsRoot } from "@smithers-orchestrator/accounts";

/** @param {NodeJS.ProcessEnv} [env] */
export function oneshotConfigPath(env = process.env) {
  return join(accountsRoot(env), "config.json");
}

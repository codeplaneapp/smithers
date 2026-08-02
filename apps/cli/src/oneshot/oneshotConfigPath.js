import { join } from "node:path";
import { accountsRoot } from "@smthrs/accounts";

/** @param {NodeJS.ProcessEnv} [env] */
export function oneshotConfigPath(env = process.env) {
  return join(accountsRoot(env), "config.json");
}

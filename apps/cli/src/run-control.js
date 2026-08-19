/**
 * The CLI's binding to `RunControl`.
 *
 * Spec 1.4 of `.smithers/specs/flows-migration.md`: "make `smithers pause`,
 * `cancel`, and `steer` thin calls onto it". This module builds the service
 * and the attribution, so each command supplies only who is asking and why.
 *
 * @typedef {import("@smthrs/engine/control/RunControl").RunControlAttribution} RunControlAttribution
 * @typedef {import("@smthrs/engine/control/RunControl").RunControlVerb} RunControlVerb
 */
import { createRunControl } from "@smthrs/engine/control/createRunControl";

export { readRunControlJournal } from "@smthrs/engine/control/readRunControlJournal";

/**
 * The actor a CLI invocation is attributed to. `SMITHERS_ACTOR` lets an
 * automation name itself; otherwise the login user is the honest answer, and
 * `cli` is the fallback when the process has no user at all.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveCliActor(env = process.env) {
  const declared = env.SMITHERS_ACTOR?.trim();
  if (declared) return declared;
  const user = (env.SMITHERS_USER ?? env.USER ?? env.USERNAME ?? "").trim();
  return user ? `cli:${user}` : "cli";
}

/**
 * @param {string} reason why the verb was invoked, journaled verbatim
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {RunControlAttribution}
 */
export function cliControlAttribution(reason, options = {}) {
  return {
    actor: resolveCliActor(options.env),
    reason,
    transport: "cli",
    clientPid: process.pid,
  };
}

/**
 * @param {import("@smthrs/db/adapter").SmithersDb} adapter
 */
export function cliRunControl(adapter) {
  return createRunControl({ adapter });
}

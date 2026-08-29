import { spawn as nodeSpawn } from "node:child_process";

import { formatSkillsAddSummary, syncCuratedSkill } from "./curatedSkillSync.js";
import { smithersRuntimeReentry } from "./node-loader/smithersRuntimeSpawn.js";

/**
 * Post-upgrade skill sync for `smithers update`.
 *
 * An upgrade must leave *every* Smithers-owned skill current (#1377). The
 * generated command skills are derived from the CLI command tree, and this
 * process still holds the pre-upgrade tree in memory — so when command skills
 * are already installed we re-exec the just-upgraded CLI's `skills add`, which
 * regenerates both sets from the new code. Otherwise (nothing to regenerate)
 * we sync the curated skill in-process; its source files are read from disk at
 * call time, so they are the freshly installed ones.
 *
 * Best-effort throughout: a failed sync never fails the upgrade.
 */

/**
 * @typedef {{
 *   via: "cli" | "in-process" | "skipped";
 *   ok: boolean;
 *   notice: string | null;
 *   error?: string;
 * }} PostUpgradeSkillSync
 */

/**
 * @param {{
 *   commandSkillsInstalled?: boolean;
 *   env?: NodeJS.ProcessEnv;
 *   version?: string | null;
 *   execPath?: string;
 *   entry?: string;
 *   spawn?: typeof nodeSpawn;
 *   sync?: typeof syncCuratedSkill;
 * }} [opts]
 * @returns {Promise<PostUpgradeSkillSync>}
 */
export async function syncSkillsAfterUpgrade(opts = {}) {
  const env = opts.env ?? process.env;
  if (env.SMITHERS_NO_SKILL_REFRESH === "1") {
    return { via: "skipped", ok: true, notice: null };
  }
  if (opts.commandSkillsInstalled) {
    const spawned = await runUpgradedSkillsAdd(opts);
    if (spawned.ok) return spawned;
    // Fall through: the curated skill is the part that silently rots, so sync
    // it in-process rather than leaving the upgrade with nothing done.
    const inProcess = syncCuratedSkillNow(opts);
    return { ...inProcess, error: spawned.error };
  }
  return syncCuratedSkillNow(opts);
}

/**
 * @param {NonNullable<Parameters<typeof syncSkillsAfterUpgrade>[0]>} opts
 * @returns {PostUpgradeSkillSync}
 */
function syncCuratedSkillNow(opts) {
  const sync = opts.sync ?? syncCuratedSkill;
  try {
    const { status, optedOut } = sync({ env: opts.env, version: opts.version });
    return {
      via: "in-process",
      ok: true,
      notice: formatSkillsAddSummary({ status, commandSkillCount: null, optedOut }),
    };
  } catch (err) {
    return { via: "in-process", ok: false, notice: null, error: err?.message ?? String(err) };
  }
}

/**
 * Re-exec the upgraded CLI's `skills add` (non-interactive) so both skill sets
 * are regenerated from the new code.
 *
 * @param {NonNullable<Parameters<typeof syncSkillsAfterUpgrade>[0]>} opts
 * @returns {Promise<PostUpgradeSkillSync>}
 */
function runUpgradedSkillsAdd(opts) {
  const spawn = opts.spawn ?? nodeSpawn;
  const entry = opts.entry ?? process.argv[1];
  if (!entry) return Promise.resolve({ via: "cli", ok: false, notice: null, error: "no CLI entry path" });
  const runtime = opts.execPath
    ? { command: opts.execPath, args: [entry, "skills", "add"] }
    : smithersRuntimeReentry([entry, "skills", "add"]);
  return new Promise((resolve) => {
    try {
      const child = spawn(runtime.command, runtime.args, { stdio: "inherit" });
      child.on("error", (err) => resolve({ via: "cli", ok: false, notice: null, error: err.message }));
      child.on("close", (code) =>
        code === 0
          ? resolve({ via: "cli", ok: true, notice: "✓ Skills re-synced by the upgraded CLI." })
          : resolve({ via: "cli", ok: false, notice: null, error: `\`skills add\` exited with code ${code}` }),
      );
    } catch (err) {
      resolve({ via: "cli", ok: false, notice: null, error: err?.message ?? String(err) });
    }
  });
}

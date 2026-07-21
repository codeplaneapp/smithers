import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountsRoot } from "@smithers-orchestrator/accounts";

/** @param {NodeJS.ProcessEnv} [env] */
export function oneshotCodexPaused(env = process.env) {
    const flag = env.SMITHERS_CODEX_PAUSED?.trim().toLowerCase();
    if (flag) return !["0", "false", "off", "no"].includes(flag);
    try {
        const marker = JSON.parse(readFileSync(join(accountsRoot(env), "codex-paused.json"), "utf8"));
        if (typeof marker?.until === "string") {
            const until = Date.parse(marker.until);
            if (Number.isFinite(until)) return Date.now() < until;
        }
        return true;
    }
    catch (error) {
        return /** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT";
    }
}

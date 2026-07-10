import { spawn } from "node:child_process";

/**
 * Proactively open the Smithers Monitor on a freshly started run: fire-and-
 * forget `smithers monitor <runId>` as a detached child so the launch command
 * never blocks on gateway autostart or the browser. Every run should be
 * watchable the moment it starts — this is the default, with three opt-outs:
 * `--no-open`, SMITHERS_NO_OPEN=1, and CI.
 *
 * @param {{
 *   runId: string;
 *   cliPath: string;
 *   enabled: boolean;
 *   env?: NodeJS.ProcessEnv;
 *   spawnImpl?: typeof spawn;
 * }} options
 * @returns {boolean} whether the monitor open was dispatched
 */
export function autoOpenMonitor({ runId, cliPath, enabled, env = process.env, spawnImpl = spawn }) {
    if (!enabled) {
        return false;
    }
    if (env.SMITHERS_NO_OPEN === "1" || env.CI) {
        return false;
    }
    try {
        const child = spawnImpl("bun", [cliPath, "monitor", runId], {
            detached: true,
            stdio: "ignore",
            env,
        });
        child.unref?.();
        return true;
    }
    catch {
        // Opening a browser is best-effort; never fail the launch over it.
        return false;
    }
}

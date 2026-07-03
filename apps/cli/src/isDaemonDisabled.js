/**
 * The daemon escape hatch (spec: .smithers/specs/singleton-gateway.md,
 * decision 18). When set, smithers must never START or REQUIRE a background
 * gateway daemon: commands that can reach the store directly do so, and
 * commands that genuinely need a daemon fail loudly rather than silently
 * autostarting one. This keeps CI, sandboxes, and containers off the daemon
 * path entirely.
 *
 * Disabled when the `--no-daemon` flag is passed (a boolean option that
 * defaults true, so the parsed `options.daemon === false`) OR the
 * `SMITHERS_NO_DAEMON` env var is set to a truthy value. Because it reads the
 * env, a shell- or daemon-spawned child (e.g. `smithers ui` autostarting a
 * gateway) inherits the setting for free — no extra plumbing.
 *
 * Note: pre-G2 no command strictly requires a daemon, so today the only effect
 * is suppressing autostart. Once reads/execution route through the daemon
 * (G2+), a command that needs a daemon while this is set must fail loudly
 * (never silently go direct); that failure is added with those milestones.
 *
 * @param {{ daemon?: boolean } | undefined} [options] Parsed command options.
 * @param {NodeJS.ProcessEnv} [env] Environment (defaults to `process.env`).
 * @returns {boolean}
 */
export function isDaemonDisabled(options, env = process.env) {
    if (options?.daemon === false) {
        return true;
    }
    const raw = env.SMITHERS_NO_DAEMON;
    if (typeof raw !== "string") {
        return false;
    }
    const value = raw.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
}

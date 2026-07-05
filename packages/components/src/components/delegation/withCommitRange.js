import { execFile } from "node:child_process";
/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */

const VCS_PROBE_TIMEOUT_MS = 5_000;

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
function run(command, args, cwd) {
    return new Promise((resolve) => {
        try {
            execFile(command, args, { cwd, timeout: VCS_PROBE_TIMEOUT_MS }, (error, stdout) => {
                if (error) {
                    resolve(null);
                    return;
                }
                const out = String(stdout ?? "").trim();
                resolve(out.length > 0 ? out : null);
            });
        }
        catch {
            resolve(null);
        }
    });
}

/**
 * Best-effort working-copy commit probe. Tries jj first (this is how a
 * colocated repo stays truthful — same probe shape as packages/vcs
 * `getJjPointer`, but on `commit_id` so `from..to` ranges work for both jj
 * and git tooling), then falls back to `git rev-parse HEAD`. Returns null
 * when neither VCS answers — callers must treat that as "omit the field".
 * @param {string} cwd
 * @returns {Promise<{ commit: string; vcs: "jj" | "git" } | null>}
 */
export async function captureWorkingCopyCommit(cwd) {
    const jj = await run("jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"], cwd);
    if (jj)
        return { commit: jj, vcs: "jj" };
    const git = await run("git", ["rev-parse", "HEAD"], cwd);
    if (git)
        return { commit: git, vcs: "git" };
    return null;
}

/**
 * Wrap an exec agent so every structured output gains a measured
 * `commitRange`: the working-copy commit is probed BEFORE `generate` runs and
 * AFTER it finishes, and `{ from, to, vcs }` is merged into the returned
 * `output` object. Strictly best-effort by contract: any probe failure, a
 * non-object result, or a text-only result leaves the output untouched —
 * commit capture must never fail an execution.
 *
 * Implemented as a Proxy so `instanceof`-based agent handling (CLI tool
 * allowlists, engine capability checks) still sees the underlying agent.
 * Caveat: code paths that RECONSTRUCT an agent from `agent.opts` (e.g. the
 * explicit-only tool allowlist) drop the wrapper — capture is then simply
 * absent, which the schema allows.
 * @param {AgentLike | AgentLike[]} agent
 * @returns {AgentLike | AgentLike[]}
 */
export function withCommitRange(agent) {
    if (Array.isArray(agent)) {
        return agent.map((entry) => /** @type {AgentLike} */ (withCommitRange(entry)));
    }
    if (!agent || typeof agent.generate !== "function") {
        return agent;
    }
    return new Proxy(agent, {
        get(target, prop, receiver) {
            if (prop !== "generate") {
                return Reflect.get(target, prop, receiver);
            }
            /** @param {import("@smithers-orchestrator/agents/BaseCliAgent/AgentGenerateOptions").AgentGenerateOptions} [args] */
            return async function generate(args) {
                const cwd = typeof args?.rootDir === "string" && args.rootDir.length > 0
                    ? args.rootDir
                    : process.cwd();
                const before = await captureWorkingCopyCommit(cwd).catch(() => null);
                const result = await target.generate.call(target, args);
                if (!before)
                    return result;
                const after = await captureWorkingCopyCommit(cwd).catch(() => null);
                if (!after || after.vcs !== before.vcs)
                    return result;
                if (result === null || typeof result !== "object" || Array.isArray(result))
                    return result;
                const output = /** @type {Record<string, unknown>} */ (result).output;
                if (output === null || typeof output !== "object" || Array.isArray(output))
                    return result;
                return {
                    .../** @type {Record<string, unknown>} */ (result),
                    output: {
                        .../** @type {Record<string, unknown>} */ (output),
                        commitRange: { from: before.commit, to: after.commit, vcs: before.vcs },
                    },
                };
            };
        },
    });
}

import { buildInlineChatWorkflow } from "../buildInlineChatWorkflow.js";
import { buildHijackLaunchSpec, isNativeHijackCandidate, launchHijackSession, resolveHijackCandidate } from "../hijack.js";

/** @typedef {import("../AgentAvailability.ts").AgentAvailability} AgentAvailability */
/** @typedef {import("./installAgentIntegration.js").AgentIntegrationResult} AgentIntegrationResult */

/**
 * Detection id → inline-chat engine for agents whose hijacked session we can
 * attach to the user's terminal natively. Agents outside this map still get
 * their pack + integration; they just skip the interactive tutorial.
 */
const TUTORIAL_ENGINES = {
    claude: "claude-code",
    codex: "codex",
    antigravity: "antigravity",
    pi: "pi",
    kimi: "kimi",
    amp: "amp",
};

/**
 * @param {string} agentId
 * @returns {import("../buildInlineChatWorkflow.js").InlineChatEngine | undefined}
 */
export function tutorialEngineFor(agentId) {
    return TUTORIAL_ENGINES[agentId];
}

/**
 * Build the bootstrap prompt for the hijacked init tutorial session. The
 * agent's first (headless) turn becomes the greeting the user sees when the
 * session opens in their terminal, so the setup narration lives here, not in
 * init's own output. Pure; unit-tested.
 *
 * @param {{
 *   cwd: string;
 *   detections: AgentAvailability[];
 *   preferredAgent: AgentAvailability;
 *   integration: AgentIntegrationResult;
 *   workflowCount: number;
 *   writtenCount: number;
 *   skippedCount: number;
 * }} opts
 * @returns {string}
 */
export function buildInitTutorialPrompt(opts) {
    const agentLines = opts.detections
        .filter((agent) => !agent.deprecated)
        .sort((left, right) => Number(right.usable) - Number(left.usable))
        .map((agent) => agent.usable
            ? `  - ${agent.displayName}: ready (${agent.status})`
            : `  - ${agent.displayName}: unavailable (${agent.unusableReasons[0] ?? "not detected"})`);
    const integrationLine = opts.integration.kind === "plugin"
        ? `The native smithers plugin was installed for ${opts.preferredAgent.displayName} (${opts.integration.detail}).`
        : opts.integration.kind === "skill"
            ? `The smithers skill was installed for ${opts.preferredAgent.displayName} (${opts.integration.detail}).`
            : `No plugin or skill could be installed for ${opts.preferredAgent.displayName} (${opts.integration.detail}).`;
    const packLine = opts.writtenCount > 0
        ? `The workflow pack was installed into .smithers/ with ${opts.workflowCount} workflows (${opts.writtenCount} files created, ${opts.skippedCount} preserved).`
        : `The workflow pack in .smithers/ is up to date with ${opts.workflowCount} workflows installed.`;
    return [
        `You are hosting the interactive Smithers tutorial for a user who just ran \`smithers init\` in ${opts.cwd}. You are ${opts.preferredAgent.displayName}, attached to a hijacked smithers session.`,
        [
            "Smithers (smithers.sh) is a durable control plane for coding agents: workflows are graphs of agent tasks that survive crashes, retry failures, pause for human approval, and can be resumed, replayed, and observed. The `smithers` CLI drives everything.",
        ].join("\n"),
        [
            "Init already finished the setup. Narrate these facts to the user up front — do not redo the setup and do not make them choose anything:",
            "",
            "Detected coding agents:",
            ...agentLines,
            "",
            `Preferred agent: ${opts.preferredAgent.displayName} (that is you).`,
            integrationLine,
            packLine,
        ].join("\n"),
        [
            "Ground rules:",
            "- Never ask the user to select between options — this tutorial has no menus. State what was detected and configured, then demonstrate.",
            "- Keep every step short and hands-on: run the commands yourself and explain the real output.",
            "- If a command fails, say what happened and keep going.",
        ].join("\n"),
        [
            "Walk the user through this arc:",
            "1. One-sentence welcome and what Smithers gives them (durable, resumable, observable agent workflows).",
            "2. What init detected and configured (the facts above).",
            "3. Run `smithers workflow list` and call out the installed pack: `create-workflow` (builds new workflows from a plain-English ask), `create-skill` (writes reusable agent skills), and `docs-driven-development` (maintains a living product spec). Former starter workflows like hello/plan/review/debug are preserved as copyable patterns under examples/init-pack/, not installed by default.",
            "4. Run `smithers ps` and explain runs, attempts, and resume — even with no runs yet, show what the output looks like once one starts.",
            "5. Show how they'd do real work: `smithers make-workflow \"<their task>\"`, or simply asking you (their coding agent, now equipped with the smithers plugin/skill) for things like \"implement X and keep iterating until the tests pass\".",
            "6. Point them at `smithers monitor` (live web UI over every run) and `smithers starters` (outcome-based templates).",
            "7. Ask if they want to explore anything else and help until they are done.",
        ].join("\n"),
        'When the user is completely done, return ONLY this raw JSON object with no prose, markdown, or code fence: {}.',
    ].join("\n\n");
}

/**
 * Run the hijacked init tutorial: execute a one-task `hijack: true` inline
 * workflow with the chosen agent (its first turn runs headless and becomes
 * the greeting), then attach the user's terminal to the recorded session.
 *
 * Never throws: every failure path returns `{ ok: false, reason }` (plus the
 * runId when one exists) so init can print a `smithers hijack <runId>`
 * fallback instead of failing after a successful install.
 *
 * @param {{ agentId: string; cwd: string; prompt: string }} opts
 * @returns {Promise<{ ok: boolean; runId?: string; reason?: string }>}
 */
export async function runInitTutorial(opts) {
    const engine = tutorialEngineFor(opts.agentId);
    if (!engine) {
        return { ok: false, reason: `${opts.agentId} does not support hijacked terminal sessions yet` };
    }
    // Same quieting as the durable re-init: the tutorial is a product surface,
    // not an engine debugging session. An explicit level is preserved.
    if (process.env.SMITHERS_LOG_LEVEL === undefined) {
        process.env.SMITHERS_LOG_LEVEL = "warn";
    }
    try {
        const [{ Effect }, { runWorkflow }, { SmithersDb }] = await Promise.all([
            import("effect"),
            import("@smithers-orchestrator/engine"),
            import("@smithers-orchestrator/db/adapter"),
        ]);
        const workflow = await buildInlineChatWorkflow({ engine, cwd: opts.cwd, prompt: opts.prompt, name: "initTutorial" });
        const closeSqlite = () => {
            try {
                const client = workflow.db?.$client;
                if (client && typeof client.close === "function") client.close();
            }
            catch { }
        };
        process.on("exit", closeSqlite);
        const result = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            rootDir: opts.cwd,
        }));
        const adapter = new SmithersDb(workflow.db);
        const candidate = result.runId
            ? await resolveHijackCandidate(adapter, result.runId, engine)
            : null;
        if (!candidate) {
            return {
                ok: false,
                runId: result.runId,
                reason: result.status === "failed"
                    ? (result.error?.message ?? `tutorial run ${result.runId} failed`)
                    : `tutorial run ${result.runId} did not produce a hijackable ${engine} session`,
            };
        }
        if (!isNativeHijackCandidate(candidate)) {
            return { ok: false, runId: result.runId, reason: `session for ${engine} is not attachable in this terminal` };
        }
        const exitCode = await launchHijackSession(buildHijackLaunchSpec(candidate));
        if (exitCode !== 0) {
            return { ok: false, runId: result.runId, reason: `${engine} exited with code ${exitCode}` };
        }
        return { ok: true, runId: result.runId };
    }
    catch (err) {
        return { ok: false, reason: err?.message ?? String(err) };
    }
}

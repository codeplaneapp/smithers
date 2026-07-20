import { SmithersError } from "@smithers-orchestrator/errors";
import { DEFAULT_AGENT_ASK_NODE_ID } from "@smithers-orchestrator/engine/human-requests";

/**
 * Run statuses we treat as "in progress" for autodetecting which run an ad-hoc
 * agent ask should attach to. Terminal/derived-dead statuses (succeeded, failed,
 * cancelled, stale, orphaned) are intentionally excluded.
 * @type {ReadonlySet<string>}
 */
export const ACTIVE_RUN_STATUSES = new Set([
    "running",
    "continued",
    "recovering",
    "waiting-approval",
    "waiting-event",
    "waiting-timer",
]);

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function parseIteration(value) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * @param {{ listRuns: (limit?: number, status?: string) => Promise<any[]> }} adapter
 * @returns {Promise<string>}
 */
async function autodetectActiveRun(adapter) {
    const runs = (await adapter.listRuns(200)) ?? [];
    const active = runs.filter((run) => ACTIVE_RUN_STATUSES.has(run?.status));
    if (active.length === 1) {
        return active[0].runId;
    }
    if (active.length === 0) {
        throw new SmithersError(
            "ASK_HUMAN_NO_ACTIVE_RUN",
            "Could not determine which run to attach the human request to: no active run found. Pass --run-id or set SMITHERS_RUN_ID.",
        );
    }
    const list = active
        .map((run) => `  ${run.runId} (${run.status})`)
        .join("\n");
    throw new SmithersError(
        "ASK_HUMAN_AMBIGUOUS_RUN",
        `Multiple active runs; pass --run-id (or set SMITHERS_RUN_ID) to choose one:\n${list}`,
    );
}

/**
 * Resolve which run/node/iteration an agent ask should attach to.
 * Priority: explicit flags -> SMITHERS_* env (injected when an agent runs inside a
 * task) -> the single active run in the local store.
 *
 * @param {{ listRuns: (limit?: number, status?: string) => Promise<any[]> }} adapter
 * @param {object} input
 * @param {string} [input.runId]
 * @param {string} [input.nodeId]
 * @param {number} [input.iteration]
 * @param {NodeJS.ProcessEnv} [input.env]
 * @returns {Promise<{ runId: string, nodeId: string, iteration: number, source: "flag" | "env" | "autodetect" }>}
 */
export async function resolveAskHumanContext(adapter, input) {
    const env = input.env ?? process.env;
    const flagRunId = nonEmpty(input.runId);
    const envRunId = nonEmpty(env.SMITHERS_RUN_ID);
    const nodeId =
        nonEmpty(input.nodeId) ??
        nonEmpty(env.SMITHERS_NODE_ID) ??
        DEFAULT_AGENT_ASK_NODE_ID;
    const iteration =
        parseIteration(input.iteration) ??
        parseIteration(env.SMITHERS_ITERATION) ??
        0;

    if (flagRunId) {
        return { runId: flagRunId, nodeId, iteration, source: "flag" };
    }
    if (envRunId) {
        return { runId: envRunId, nodeId, iteration, source: "env" };
    }
    const runId = await autodetectActiveRun(adapter);
    return { runId, nodeId, iteration, source: "autodetect" };
}

/**
 * A short uniqueness token for an ad-hoc ask request id. Injectable clock/RNG for
 * deterministic tests.
 *
 * @param {() => number} [now]
 * @param {() => number} [rand]
 * @returns {string}
 */
export function buildAskUniqueToken(now = Date.now, rand = Math.random) {
    const stamp = Math.floor(now()).toString(36);
    const noise = Math.floor(rand() * 0xffffff)
        .toString(36)
        .padStart(4, "0");
    return `ask-${stamp}-${noise}`;
}

/**
 * @param {string} prompt
 * @param {string | undefined} context
 * @returns {string}
 */
export function buildAskPromptText(prompt, context) {
    const base = prompt.trim();
    const extra = nonEmpty(context);
    return extra ? `${base}\n\nContext:\n${extra}` : base;
}

/**
 * Parse a comma-separated `--choices` value into a deduped, trimmed list.
 *
 * @param {string | undefined} raw
 * @returns {string[] | null}
 */
export function parseChoices(raw) {
    const value = nonEmpty(raw);
    if (!value) {
        return null;
    }
    const seen = new Set();
    const choices = [];
    for (const part of value.split(",")) {
        const choice = part.trim();
        if (choice.length > 0 && !seen.has(choice)) {
            seen.add(choice);
            choices.push(choice);
        }
    }
    return choices.length > 0 ? choices : null;
}

/**
 * Build the human-request fields for a free-form ask or a fixed-choice select.
 * For a select we store a JSON-schema enum so `smithers human answer` rejects any
 * value that is not one of the offered choices.
 *
 * @param {string[] | null} choices
 * @returns {{ kind: "ask" | "select", optionsJson: string | null, schemaJson: string | null }}
 */
export function buildAskKindFields(choices) {
    if (!choices) {
        return { kind: "ask", optionsJson: null, schemaJson: null };
    }
    return {
        kind: "select",
        optionsJson: JSON.stringify(choices),
        schemaJson: JSON.stringify({ type: "string", enum: choices }),
    };
}

/**
 * Operator-facing instructions printed when a request is created, so a human can
 * resolve it from another terminal.
 *
 * @param {string} requestId
 * @param {string[] | null} choices
 * @returns {string}
 */
export function formatAskHumanResolveHelp(requestId, choices) {
    const example = choices && choices.length > 0
        ? `'${JSON.stringify(choices[0])}'`
        : `'"approve"'`;
    return [
        "🛑 Smithers is blocked and waiting for a human decision.",
        `   request: ${requestId}`,
        "",
        "   Resolve from another terminal:",
        `     smithers human answer ${requestId} --value ${example}`,
        `     smithers human cancel ${requestId}`,
        "   Or list everything waiting:",
        "     smithers human inbox",
    ].join("\n");
}

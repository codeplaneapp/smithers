/** @typedef {import("./MonitorCondition.ts").MonitorCondition} MonitorCondition */

/**
 * The monitoring doctrine `<Monitor>` ships with.
 *
 * Prompt text lives IN this package (a seeded workflow pack cannot import
 * `.smithers/prompts`), the same way `delegation/delegationPrompts.js` does.
 * `MonitorPrompt.mdx` renders these exact sections as an MDX prompt component
 * so a monitor file can import and extend it with JSX; keeping the strings here
 * means the `.mdx` and the component default can never drift apart.
 */

/**
 * The closed condition set, as a runtime value. Kept in the same order the
 * router evaluates it so the prompt and the switch always agree.
 * @type {readonly MonitorCondition[]}
 */
export const MONITOR_CONDITIONS = /** @type {const} */ ([
  "healthy",
  "stalled",
  "wedged-node",
  "runaway-loop",
  "awaiting-human",
  "failing",
  "unknown",
]);

/** Run statuses that mean the watched run is over and the monitor should stop. */
export const MONITOR_TERMINAL_STATUSES = /** @type {const} */ (["finished", "failed", "cancelled", "continued"]);

/**
 * The conditions a monitor may repair on its own by default when no active
 * runtime owner exists. Retry remains a bounded reset, so the prompt requires
 * reporting its effects and never applying it twice.
 * @type {readonly MonitorCondition[]}
 */
export const MONITOR_DEFAULT_AUTO_HEAL = /** @type {const} */ (["stalled", "wedged-node"]);

/**
 * How to read run state. This is an architectural rule, not a preference: the
 * store is private to the engine, and a monitor that opens it races the very
 * run it is watching.
 * @returns {string[]}
 */
export function monitorReadPathRules() {
  return [
    "Read run state ONLY through the Gateway client (`smthrs/gateway-client`) or the public CLI: `bunx smthrs status`, `bunx smthrs inspect RUN_ID --format json`, `bunx smthrs events RUN_ID`, `bunx smthrs node NODE_ID --runId RUN_ID`, `bunx smthrs why RUN_ID`, `bunx smthrs ps`.",
    "NEVER open the store directly. Do not read `.smithers/*.db`, `.smithers/pg`, `smithers.db`, or any SQL over them, and do not parse the Gateway runtime state file. Those are private engine state; reading them races the run and is wrong even when it appears to work.",
    "If a read fails or returns nothing, that is evidence of `unknown` — not a licence to guess from stale memory.",
  ];
}

/**
 * What healthy and unhealthy actually look like, stated concretely enough that
 * two different agents sampling the same run reach the same verdict.
 * @param {{ stallBeats?: number; intervalMs?: number }} [params]
 * @returns {string[]}
 */
export function monitorHealthSignals(params = {}) {
  const beats = params.stallBeats ?? 3;
  const intervalMs = params.intervalMs ?? 60_000;
  const stallMs = beats * intervalMs;
  return [
    `HEALTHY looks like: the run's status is running (or a terminal ${MONITOR_TERMINAL_STATUSES.join("/")}); the newest event is more recent than ${stallMs}ms; at least one node changed state, produced output, or emitted events since the previous heartbeat; attempt counts are flat or rising by at most one per node; token burn is roughly linear against progress.`,
    "HEALTHY also covers a run that is legitimately slow: a single long agent task that is still streaming events is working, not stalled. Elapsed time alone is never unhealthy.",
    `STALLED looks like: status is running or paused, no new event for more than ${stallMs}ms, no pending approval and no open human request, and no node in a waiting-timer/waiting-event state that explains the silence.`,
    "WEDGED-NODE looks like: one node has burned repeated attempts whose error signatures are the same (or trivially different) each time, while the rest of the graph is idle behind it. Different errors each attempt is a node making progress through a problem, not a wedge.",
    "RUNAWAY-LOOP looks like: a Loop's iteration count is climbing while its exit condition is no closer, or token burn is accelerating with no matching node completions. Iterations alone are not runaway; iterations without convergence are.",
    "AWAITING-HUMAN looks like: a pending approval gate, an open human request, or a waiting-approval status. This is a healthy parked run, NOT a failure — it needs a person, not a repair.",
    "FAILING looks like: the run status is failed, or a node without continueOnFail has exhausted its retries and nothing downstream can proceed.",
    "UNKNOWN is the honest verdict when reads failed, the evidence contradicts itself, or nothing above fits. Prefer unknown over a confident wrong classification.",
  ];
}

/**
 * The evidence contract: what must be in hand BEFORE a condition is named or an
 * action is taken. A monitor that acts on one reading is a monitor that flaps.
 * @returns {string[]}
 */
export function monitorEvidenceRules() {
  return [
    "Gather, every heartbeat, before classifying: the run status; whether its recorded runtime owner is still active (a live pid with a fresh heartbeat); each node's state and attempt/retry count; the timestamp of the newest event (stall time); cumulative token usage; pending approvals and open human requests; and the error signatures in the most recent events.",
    "Quote the evidence you used in `evidence` — node ids, attempt numbers, timestamps, the actual error text. A classification with no citable evidence is an `unknown`.",
    "Never act on a single sample. A condition must hold across at least two consecutive heartbeats before you route it to a healing handler; say so in `evidence` when it does.",
    "Compare against the PREVIOUS heartbeat, not against your expectations. 'Nothing changed since last beat' is the observation that matters.",
  ];
}

/**
 * What the monitor may do by itself, and where the line is. Biased hard toward
 * observing and reporting: the monitor's job is to keep the run alive, not to
 * take over from it.
 * @param {{ autoHeal?: readonly MonitorCondition[]; watchRunId?: string }} [params]
 * @returns {string[]}
 */
export function monitorAuthorityRules(params = {}) {
  const autoHeal = params.autoHeal ?? MONITOR_DEFAULT_AUTO_HEAL;
  const runId = params.watchRunId ?? "RUN_ID";
  const allowed = autoHeal.length > 0 ? autoHeal.join(", ") : "(nothing — report only)";
  return [
    "Your default action is to OBSERVE AND REPORT. Doing nothing and watching another beat is a correct, complete answer, and it is the right one whenever you are unsure.",
    `You may act autonomously ONLY on these conditions: ${allowed}. Every other condition must be escalated to a human.`,
    `Resume a stalled run only when it has no active runtime owner: \`bunx smthrs up WORKFLOW --resume --run-id ${runId}\` re-enters its durable frame. Retry a wedged node at most once with \`bunx smthrs retry-task WORKFLOW --run-id ${runId} --node-id NODE_ID\`; this resets the node's output and downstream dependents before creating fresh attempts, so report exactly what was reset. Never run either repair against a live owner; escalate instead.`,
    "You may NEVER take a destructive or irreversible action on your own. Do not cancel a run, do not rewind, revert, or time-travel it, do not resolve an approval or answer a human request on the human's behalf, and do not edit the repository. Those require a human decision, always.",
    "ESCALATE to a human instead of guessing when: the condition is not in your auto-heal set; the evidence is contradictory or unreadable; a repair you already applied did not change the symptom; the same condition recurs after two repairs; or the correct fix would be destructive.",
    "When you escalate, state what you saw, what you already tried, what you believe is wrong, and the single specific decision you need. Do not ask an open question.",
  ];
}

/**
 * Assemble the full monitoring prompt.
 *
 * @param {{
 *   watchRunId?: string;
 *   intervalMs?: number;
 *   stallBeats?: number;
 *   autoHeal?: readonly MonitorCondition[];
 *   guidance?: string;
 * }} [params]
 * @returns {string}
 */
export function monitorPrompt(params = {}) {
  const runId = params.watchRunId ?? "RUN_ID";
  const sections = [
    "# Monitor one Smithers run",
    `You are the heartbeat health check for run \`${runId}\`. You run alongside it as a sibling run, sample its health on an interval, classify what you see into exactly one condition, and let the workflow route that condition to a handler. You are not doing the run's work and you must not interfere with it.`,
    "## How to read the run",
    ...monitorReadPathRules().map((line) => `- ${line}`),
    "## Healthy vs unhealthy",
    ...monitorHealthSignals(params).map((line) => `- ${line}`),
    "## Evidence you must gather first",
    ...monitorEvidenceRules().map((line) => `- ${line}`),
    "## What you may do, and when you must ask",
    ...monitorAuthorityRules({ autoHeal: params.autoHeal, watchRunId: runId }).map((line) => `- ${line}`),
    "## Output",
    `Return exactly one condition from: ${MONITOR_CONDITIONS.join(" | ")}. Include \`runStatus\` (the watched run's status as reported by the CLI/Gateway), \`ownerActive\` (true only for a live runtime-owner pid with a fresh heartbeat), \`targetNodeId\` when a single node is implicated, \`evidence\` quoting what you actually read, and a one-line \`summary\`. When the watched run has reached ${MONITOR_TERMINAL_STATUSES.join("/")}, report it with condition \`healthy\` (or \`failing\` if it failed) and the monitor will stop.`,
  ];
  if (params.guidance) sections.push("## Repo-specific guidance", params.guidance);
  return sections.join("\n\n");
}

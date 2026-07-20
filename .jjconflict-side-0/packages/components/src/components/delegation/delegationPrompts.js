import { zodSchemaToJsonExample } from "../../zod-to-example.js";
import { dcDevPreviewSchema, dcExecSchema, dcForecastSchema, dcGatesSchema, dcGoalApprovalSchema, dcGoalSchema, dcPlanSchema, dcPollSchema, dcPreviewSchema, dcProbeSchema, dcQuestionSchema, dcReplanSchema, dcReviewSchema, } from "./delegationSchemasRuntime.js";
/** @typedef {import("./delegationSchemas.ts").Tier} Tier */
/** @typedef {import("./delegationState.js").DelegationNodeInfo} DelegationNodeInfo */
/** @typedef {import("./delegationState.js").DeriskTrigger} DeriskTrigger */

/**
 * Prompt templates for every delegation-chain tier/phase. Prompt text lives IN
 * this package (seeded workflow packs cannot import `.smithers/prompts`).
 *
 * Delegating-tier prompts (plan/replan/backpressure/review/goal) embed the
 * distilled context-engineering principles; leaf (sonnet) and probe (haiku)
 * prompts stay lean task briefs.
 */

/**
 * The distilled context-engineering principles every DELEGATING-tier prompt
 * carries (condensed from the layered model: prompt → context → harness →
 * workflow → backpressure).
 * @returns {string}
 */
export function contextPrinciples() {
    return [
        "Context-engineering principles (you are a delegating agent — these govern how you delegate):",
        "- A brief is a CONTEXT CONTRACT: state the goal, non-goals, inputs (and where each comes from), success criteria, and known risks. A child that must guess is a brief you failed to write.",
        "- Keep each child's working set MINIMAL: give it only the context its own task needs, never the whole tree. Plans and research happen up front so executors spend attention on the work.",
        "- Reports bubble via the NEAREST PARENT only. You read your children's reports and pass a distilled summary upward; no node ever sees the full tree.",
        "- Declare backpressure BEFORE execution: every success criterion maps to a gate (check command, review, or approval) declared ahead of the code that must pass it.",
        "- Flag risks HONESTLY — you are scored on probe judgment. A risk you failed to flag that later breaks the plan is punished hardest (false negative). A flagged risk whose probe changes the plan earns the strongest reward. Marking a considered risk as routine (probe: null) is a scored judgment, not an omission.",
    ].join("\n");
}

/**
 * Estimate discipline shared by plan and replan prompts.
 * @returns {string}
 */
function estimateRules() {
    return [
        "Estimates are REQUIRED and SCORED: give every child an estimate { tokens, costUsd, minutes } and roll your whole subtree up into subtreeEstimate.",
        "Your estimates are compared to measured actuals by the estimateAccuracy scorer. Forecast honestly — a flattering number loses to an accurate one.",
    ].join("\n");
}

/**
 * Approval-policy passthrough for delegating prompts. Empty when no policy.
 * @param {string | undefined} approvalPolicy
 * @returns {string}
 */
function approvalPolicyRules(approvalPolicy) {
    if (!approvalPolicy)
        return "Approval gates are DISABLED for this run: never declare a gate with method \"approval\".";
    return [
        "An approval policy is active for this run:",
        `--- APPROVAL POLICY ---\n${approvalPolicy}\n--- END APPROVAL POLICY ---`,
        "Add a gate with method \"approval\" ONLY where this policy actually applies (set policyMatch to the matching clause). Everything else stays automatic.",
        "When you delegate, pass a CLARIFIED version of the policy down in each child's brief — restate only the clauses relevant to that child's work.",
    ].join("\n");
}

/**
 * Fable/opus goal-refinement question forecast.
 * @param {{ prompt: string; maxQuestions: number; approvalPolicy?: string }} opts
 * @returns {string}
 */
export function goalQuestionsPrompt(opts) {
    return [
        "You are the goal-refinement agent of a delegation chain. A user handed you an ambiguous ask; before anything is planned you refine it.",
        contextPrinciples(),
        "",
        "--- USER PROMPT ---",
        opts.prompt,
        "--- END USER PROMPT ---",
        "",
        "Forecast, UPFRONT and in one shot, every question you need the user to answer:",
        "- Ask ONLY genuine user-preference questions — scope, taste, intent, appetite for risk. NEVER ask anything discoverable from the repository, docs, tools, or memory: answer those yourself and carry them as assumptions.",
        `- Forecast the full count now (total) and number the questions seq 1..N, most plan-changing first. Ask at most ${opts.maxQuestions}. Zero questions is a valid forecast.`,
        "- Every question carries a recommended default and the reason for it, so the user can accept your judgment with one click.",
        "- Each question requires: seq (int), question, kind (one of \"select\"|\"confirm\"|\"text\"), recommended, reason — and for kind \"select\" an options array of { label, description }.",
        opts.approvalPolicy ? approvalPolicyRules(opts.approvalPolicy) : "",
        "",
        "Return JSON matching (logicalId is always \"goal\"):",
        zodSchemaToJsonExample(dcForecastSchema),
        `Example question element: ${JSON.stringify({ seq: 1, question: "Which layout?", kind: "select", options: [{ label: "Grid", description: "cards in a grid" }, { label: "List", description: "vertical list" }], recommended: "Grid", reason: "denser overview" })}`,
    ].filter(Boolean).join("\n");
}

/**
 * Haiku form-metadata render for one forecast question (lean brief).
 * @param {{ question: Record<string, any> }} opts
 * @returns {string}
 */
export function questionFormPrompt(opts) {
    return [
        "Render UI form metadata for ONE goal-refinement question. Do not answer it; do not add questions.",
        "",
        "--- QUESTION ---",
        JSON.stringify(opts.question, null, 2),
        "--- END QUESTION ---",
        "",
        "Write a short header (form section title), keep kind/options/recommended/reason faithful to the question (you may tighten wording), set resolved to false and logicalId to \"goal\".",
        "Return JSON matching:",
        zodSchemaToJsonExample(dcQuestionSchema),
    ].join("\n");
}

/**
 * Fable goal refinement after all questions are answered.
 * @param {{ prompt: string; qa: Array<{ question: string; answer: string }>; approvalPolicy?: string }} opts
 * @returns {string}
 */
export function goalRefinePrompt(opts) {
    const qa = opts.qa.length === 0
        ? "(no questions were needed)"
        : opts.qa.map((entry, i) => `Q${i + 1}: ${entry.question}\nA${i + 1}: ${entry.answer}`).join("\n\n");
    return [
        "You are the goal-refinement agent of a delegation chain. The user has answered your questions; write the refined prompt the planning tier will build from.",
        contextPrinciples(),
        "",
        "--- ORIGINAL PROMPT ---",
        opts.prompt,
        "--- END ORIGINAL PROMPT ---",
        "",
        "--- ANSWERS ---",
        qa,
        "--- END ANSWERS ---",
        "",
        "The refinedPrompt is the root context contract: goal, non-goals, inputs, success criteria, risks. List every implementation question you resolved yourself under assumptions. Set questionsAsked to the number of questions the user actually answered.",
        opts.approvalPolicy ? approvalPolicyRules(opts.approvalPolicy) : "",
        "Return JSON matching (logicalId is always \"goal\"):",
        zodSchemaToJsonExample(dcGoalSchema),
    ].filter(Boolean).join("\n");
}

/**
 * The refined-prompt approval form shown to the human.
 * @param {{ goal: Record<string, any> }} opts
 * @returns {string}
 */
export function goalApprovalPrompt(opts) {
    return [
        "Review the refined goal below. Edit the refined prompt as you see fit, then approve — your (possibly edited) refinedPrompt becomes the root brief the plan is built from.",
        "",
        "--- REFINED GOAL ---",
        JSON.stringify({
            logicalId: "goal",
            refinedPrompt: opts.goal.refinedPrompt,
            assumptions: opts.goal.assumptions,
            questionsAsked: opts.goal.questionsAsked,
        }, null, 2),
        "--- END REFINED GOAL ---",
        "",
        "Submit JSON matching:",
        zodSchemaToJsonExample(dcGoalApprovalSchema),
    ].join("\n");
}

/**
 * Delegating-tier decomposition prompt (also used for replan-generated new
 * plan versions via `replan`).
 * @param {{
 *   logicalId: string;
 *   tier: Tier;
 *   brief: string;
 *   parent?: { logicalId: string; title: string } | undefined;
 *   depth: number;
 *   maxDepth: number;
 *   tierOrder: readonly Tier[];
 *   approvalPolicy?: string | undefined;
 *   replan?: { round: number; reason: string; triggerRef: string } | undefined;
 * }} opts
 * @returns {string}
 */
export function planPrompt(opts) {
    const nextTier = opts.tierOrder[Math.min(opts.tierOrder.indexOf(opts.tier) + 1, opts.tierOrder.length - 1)];
    const mustLeaf = opts.depth + 1 >= opts.maxDepth;
    return [
        `You are the "${opts.tier}"-tier owner of delegation node "${opts.logicalId}"${opts.parent ? ` (child of "${opts.parent.logicalId}": ${opts.parent.title})` : ""}. Decompose your chunk for the tier below you.`,
        contextPrinciples(),
        "",
        "--- YOUR BRIEF (from your parent) ---",
        opts.brief,
        "--- END BRIEF ---",
        "",
        opts.replan
            ? `THIS IS A REPLAN (round ${opts.replan.round}, trigger ${opts.replan.triggerRef}). Your previous plan was invalidated: ${opts.replan.reason}. Produce the corrected plan; RE-FORECAST every estimate honestly from what you now know — do not anchor on your original numbers.`
            : "",
        "Rules:",
        `- Children use path-style logical ids under yours: "${opts.logicalId}/<short-name>". Ids may contain only letters, digits, hyphen and underscore in each "/"-separated segment (no spaces, dots, or colons).`,
        mustLeaf
            ? `- You are at depth ${opts.depth} of max ${opts.maxDepth}: EVERY child must be kind "leaf".`
            : `- Declare each child "chunk" (needs further decomposition by a "${nextTier}"-tier owner) or "leaf" (directly executable). Split by EXECUTION context windows, not planning vanity — a small graph that fits the ask beats a deep one.`,
        "- Each child's brief is its full context contract (goal / non-goals / inputs / success criteria / risks). The child will see YOUR brief only through what you write here.",
        estimateRules(),
        "- risks[]: every risk you considered. Set probe to \"research\" (a doc-reading question must be answered) or \"poc\" (something must be proven to work) — or null with your reason when you judge it routine. Both choices are scored.",
        approvalPolicyRules(opts.approvalPolicy),
        "",
        "Return JSON matching:",
        zodSchemaToJsonExample(dcPlanSchema),
    ].filter(Boolean).join("\n");
}

/**
 * Haiku zero-backpressure preview of a leaf's expected output (lean brief).
 * @param {{ leaf: DelegationNodeInfo }} opts
 * @returns {string}
 */
export function previewPrompt(opts) {
    return [
        `Render the EXPECTED OUTPUT of delegation leaf "${opts.leaf.logicalId}" (${opts.leaf.title}) as markdown/pseudocode.`,
        "This preview is NEVER EXECUTED — it exists purely to calibrate the plan before real work starts, and it is always displayed under a \"never executed — calibration only\" warning. Do not run anything; do not write files.",
        "",
        "--- LEAF BRIEF ---",
        opts.leaf.brief,
        "--- END LEAF BRIEF ---",
        "",
        `Return JSON matching (logicalId is "${opts.leaf.logicalId}"):`,
        zodSchemaToJsonExample(dcPreviewSchema),
    ].join("\n");
}

/**
 * Delegating-tier backpressure declaration for one node.
 * @param {{
 *   node: DelegationNodeInfo;
 *   knownNodeIds: string[];
 *   approvalPolicy?: string | undefined;
 * }} opts
 * @returns {string}
 */
export function gatesPrompt(opts) {
    return [
        `Declare the backpressure gates and dependencies for delegation node "${opts.node.logicalId}" (${opts.node.title}) BEFORE any execution starts.`,
        contextPrinciples(),
        "",
        "--- NODE BRIEF ---",
        opts.node.brief,
        "--- END NODE BRIEF ---",
        "",
        "Rules:",
        "- gates[]: map each success criterion of the brief to a gate — { method: \"check\", command } for anything a command can prove (tests, typecheck), { method: \"review\", tier, brief } for judgment calls (state exactly what the reviewer must verify).",
        "- Developer previews are gates too: { method: \"preview\", kind, brief } builds a SHOWABLE artifact after execution and its successful build is required to pass. kind: \"app\" (the built thing itself), \"terminal\" (rendered terminal + driving instructions), \"api\" (an explorer over the built API), \"throwaway-ui\" (a disposable UI over the work), \"slideshow\" (an HTML slideshow of what was done — the fallback when there is no runnable code). Add one wherever the work deserves to be SEEN, not just reviewed.",
        opts.node.parentId === null || opts.node.logicalId === "root"
            ? "- REQUIRED for this root node: include a { method: \"preview\", kind: \"slideshow\", brief } gate, so the run always ends with a showable summary of what was done."
            : "",
        approvalPolicyRules(opts.approvalPolicy),
        `- depsLogical[]: the logical ids this node must wait for (execution-order + backpressure). Known nodes: ${opts.knownNodeIds.join(", ")}. Never invent ids.`,
        "",
        "Return JSON matching:",
        zodSchemaToJsonExample(dcGatesSchema),
    ].filter(Boolean).join("\n");
}

/**
 * Probe task brief (lean — haiku research / sonnet poc).
 * @param {{
 *   parentLogicalId: string;
 *   probeId: string;
 *   kind: "poc" | "research";
 *   risk: { id: string; description: string; reason: string };
 *   parentBrief: string;
 * }} opts
 * @returns {string}
 */
export function probePrompt(opts) {
    return [
        opts.kind === "research"
            ? `Research probe for delegation node "${opts.parentLogicalId}": answer the question below by READING (docs, code, existing behavior). Do not modify anything.`
            : `POC probe for delegation node "${opts.parentLogicalId}": PROVE the risky thing below actually works with the smallest possible throwaway experiment. Leave no permanent changes.`,
        "",
        `--- RISK (${opts.risk.id}) ---`,
        opts.risk.description,
        `Why probed: ${opts.risk.reason}`,
        "--- END RISK ---",
        "",
        "--- PARENT CONTEXT (excerpt) ---",
        opts.parentBrief,
        "--- END PARENT CONTEXT ---",
        "",
        "Report requirements:",
        "- report: well-sourced markdown — cite the files/docs/commands that back every claim. Your report goes to your NEAREST PARENT only.",
        "- planImpact: \"changes\" if the parent's plan must change (then set proposedChange), \"confirms\" if the plan is validated, \"none\" if irrelevant. Judge honestly — this is scored: a missed real impact is punished hardest; a correct \"changes\" that fixes the plan is rewarded most.",
        "",
        `Return JSON matching (probeId "${opts.probeId}", parentLogicalId "${opts.parentLogicalId}", kind "${opts.kind}"):`,
        zodSchemaToJsonExample(dcProbeSchema),
    ].join("\n");
}

/**
 * Delegating-tier replan decision for one affected node.
 * @param {{
 *   logicalId: string;
 *   round: number;
 *   plan: Record<string, any> | undefined;
 *   brief: string;
 *   triggers: DeriskTrigger[];
 *   approvalPolicy?: string | undefined;
 * }} opts
 * @returns {string}
 */
export function replanPrompt(opts) {
    const primary = opts.triggers[0];
    const triggerText = opts.triggers
        .map((t) => t.type === "probe"
            ? `probe ${t.ref}: planImpact=changes — ${String(t.detail.proposedChange ?? t.detail.answer ?? "")}\nReport:\n${String(t.detail.report ?? "")}`
            : t.type === "review-fail"
                ? `chunk review FAILED on "${t.flagged}" (ref ${t.ref}):\n${String(t.detail.feedback ?? t.detail.proposedChange ?? "")}`
                : `user edit ${t.ref} on ${t.flagged}: ${String(t.detail.note ?? "")}\nEdited output:\n${JSON.stringify(t.detail.editedOutput ?? null)}`)
        .join("\n\n");
    return [
        `Replan decision (round ${opts.round}) for delegation node "${opts.logicalId}". Something changed; decide whether your plan survives.`,
        contextPrinciples(),
        "",
        "--- YOUR CURRENT PLAN ---",
        opts.plan ? JSON.stringify(opts.plan, null, 2) : `(no plan row — brief: ${opts.brief})`,
        "--- END CURRENT PLAN ---",
        "",
        "--- TRIGGERS ---",
        triggerText,
        "--- END TRIGGERS ---",
        "",
        "Decide:",
        "- \"reaffirmed\": your plan survives the change as-is. Say WHY in reason — an unexamined reaffirm is a scored false negative waiting to happen.",
        "- \"invalidated\": your plan must change. State what breaks in reason; a fresh plan version will be requested from you next, and you must RE-FORECAST its estimates honestly rather than anchoring on the old numbers.",
        approvalPolicyRules(opts.approvalPolicy),
        "",
        `Return JSON matching (round ${opts.round}, logicalId "${opts.logicalId}", trigger { type: "${primary?.type ?? "probe"}", ref: "${primary?.ref ?? ""}" }):`,
        zodSchemaToJsonExample(dcReplanSchema),
    ].filter(Boolean).join("\n");
}

/**
 * Leaf executor brief (lean, sonnet-tier).
 * @param {{
 *   leaf: DelegationNodeInfo;
 *   gates: import("./delegationSchemas.ts").Gate[];
 *   attempt: number;
 *   feedback: string[];
 * }} opts
 * @returns {string}
 */
export function execPrompt(opts) {
    const gateText = opts.gates.length === 0
        ? "(none declared)"
        : opts.gates
            .map((gate) => gate.method === "check"
                ? `- check: ${gate.command}`
                : gate.method === "review"
                    ? `- review (${gate.tier}): ${gate.brief}`
                    : gate.method === "preview"
                        ? `- preview (${gate.kind}): ${gate.brief}`
                        : `- approval: ${gate.policyMatch}`)
            .join("\n");
    return [
        `Execute delegation leaf "${opts.leaf.logicalId}" (${opts.leaf.title}). Attempt ${opts.attempt}.`,
        "",
        "--- BRIEF ---",
        opts.leaf.brief,
        "--- END BRIEF ---",
        "",
        "Gates your work must pass:",
        gateText,
        opts.feedback.length > 0
            ? `\n--- REVIEW FEEDBACK FROM PREVIOUS ATTEMPT (fix all of it) ---\n${opts.feedback.join("\n\n")}\n--- END FEEDBACK ---`
            : "",
        "",
        `When done, return JSON matching (logicalId "${opts.leaf.logicalId}", attempt ${opts.attempt}; include actual { tokens, costUsd, minutes } if you can measure or estimate your own usage, otherwise omit it; omit commitRange — it is measured for you):`,
        zodSchemaToJsonExample(dcExecSchema),
    ].filter(Boolean).join("\n");
}

/**
 * Commit-inspection block for review prompts. The reviewer inspects commits
 * itself and generates any diff it needs — nothing is pre-baked.
 * @param {Array<{ from: string; to: string; vcs: "jj" | "git" }>} commitRanges
 * @returns {string}
 */
function commitInspectionRules(commitRanges) {
    if (commitRanges.length === 0) {
        return "No commit range was captured for this work — locate the changes yourself (e.g. `jj log`, `git log`) before judging.";
    }
    const ranges = commitRanges
        .map((range) => `- ${range.vcs}: ${range.from}..${range.to}`)
        .join("\n");
    return [
        "--- COMMITS PRODUCED (inspect them YOURSELF) ---",
        ranges,
        "--- END COMMITS ---",
        "Inspect the commits directly and generate whatever diff you need — none is pre-baked into this prompt:",
        "- jj: `jj log -r <from>..<to>`, `jj diff --from <from> --to <to>`, `jj show <rev>`",
        "- git: `git log <from>..<to>`, `git diff <from> <to>`, `git show <rev>`",
        "Your verdict must cite evidence from the commits (files, hunks, revs).",
    ].join("\n");
}

/**
 * Review-gate prompt (delegating tier — strict). The reviewer receives the
 * reviewed node's structured output and its commit range(s), and inspects the
 * commits itself.
 * @param {{
 *   leaf: DelegationNodeInfo;
 *   gate: { method: "review"; tier: Tier; brief: string };
 *   attempt: number;
 *   execOutput: Record<string, any> | undefined;
 *   commitRanges: Array<{ from: string; to: string; vcs: "jj" | "git" }>;
 * }} opts
 * @returns {string}
 */
export function reviewPrompt(opts) {
    return [
        `You are the strict review gate for delegation leaf "${opts.leaf.logicalId}" (attempt ${opts.attempt}).`,
        contextPrinciples(),
        "",
        "--- WHAT TO VERIFY (the gate brief, declared before execution) ---",
        opts.gate.brief,
        "--- END GATE BRIEF ---",
        "",
        "--- LEAF BRIEF (the context contract the work had to satisfy) ---",
        opts.leaf.brief,
        "--- END LEAF BRIEF ---",
        "",
        "--- EXECUTOR OUTPUT (its own output spec) ---",
        opts.execOutput ? JSON.stringify(opts.execOutput, null, 2) : "(no output row — inspect the work directly)",
        "--- END EXECUTOR OUTPUT ---",
        "",
        commitInspectionRules(opts.commitRanges),
        "",
        "Inspect the actual work, not just the self-report. verdict \"pass\" ONLY when every success criterion of the gate brief is met; otherwise \"fail\" with concrete, actionable, evidence-citing feedback (it is folded into the next attempt's brief).",
        "",
        `Return JSON matching (logicalId "${opts.leaf.logicalId}", attempt ${opts.attempt}):`,
        zodSchemaToJsonExample(dcReviewSchema),
    ].join("\n");
}

/**
 * Chunk-level review-gate prompt: reviews a planning node's whole completed
 * subtree against the union of its leaves' commit ranges.
 * @param {{
 *   node: DelegationNodeInfo;
 *   gate: { method: "review"; tier: Tier; brief: string };
 *   execOutputs: Array<Record<string, any>>;
 *   commitRanges: Array<{ from: string; to: string; vcs: "jj" | "git" }>;
 * }} opts
 * @returns {string}
 */
export function chunkReviewPrompt(opts) {
    return [
        `You are the strict review gate for delegation node "${opts.node.logicalId}" (${opts.node.title}) — its whole subtree has executed; judge the assembled result.`,
        contextPrinciples(),
        "",
        "--- WHAT TO VERIFY (the gate brief, declared before execution) ---",
        opts.gate.brief,
        "--- END GATE BRIEF ---",
        "",
        "--- NODE BRIEF ---",
        opts.node.brief,
        "--- END NODE BRIEF ---",
        "",
        "--- SUBTREE OUTPUTS ---",
        opts.execOutputs.length > 0
            ? opts.execOutputs.map((row) => JSON.stringify(row, null, 2)).join("\n\n")
            : "(no outputs — inspect the work directly)",
        "--- END SUBTREE OUTPUTS ---",
        "",
        commitInspectionRules(opts.commitRanges),
        "",
        "verdict \"pass\" ONLY when every success criterion of the gate brief is met across the subtree; otherwise \"fail\" with concrete, evidence-citing feedback.",
        "",
        `Return JSON matching (logicalId "${opts.node.logicalId}", attempt 1):`,
        zodSchemaToJsonExample(dcReviewSchema),
    ].join("\n");
}

/**
 * Check-gate prompt (lean — run one command, report the verdict).
 * @param {{
 *   leaf: DelegationNodeInfo;
 *   gate: { method: "check"; command: string };
 *   attempt: number;
 * }} opts
 * @returns {string}
 */
export function checkPrompt(opts) {
    return [
        `Run this check for delegation leaf "${opts.leaf.logicalId}" (attempt ${opts.attempt}):`,
        "",
        `    ${opts.gate.command}`,
        "",
        "Run the command exactly. verdict \"pass\" only on a clean exit; on failure, put the relevant error output in feedback.",
        `Return JSON matching (logicalId "${opts.leaf.logicalId}", attempt ${opts.attempt}):`,
        zodSchemaToJsonExample(dcReviewSchema),
    ].join("\n");
}

/**
 * Developer-preview gate task (haiku/sonnet-tier, lean): build the showable
 * artifact for a node after its execution.
 * @param {{
 *   logicalId: string;
 *   title: string;
 *   gate: { method: "preview"; kind: import("./delegationSchemas.ts").DevPreviewKind; brief: string };
 *   attempt: number;
 *   execSummaries: string[];
 *   feedback: string[];
 * }} opts
 * @returns {string}
 */
export function devPreviewPrompt(opts) {
    const kindBrief = {
        app: "Build (or wire up) the runnable thing itself and expose it: artifact.type \"url\" pointing at the running app, or \"html\" embedding it. Verify it actually starts before reporting builtOk.",
        terminal: "Produce a rendered terminal walkthrough: artifact.type \"markdown\" with a realistic transcript of driving the CLI, plus `instructions` telling the user exactly how to run it themselves.",
        api: "Build a small explorer over the built API: artifact.type \"html\" (self-contained, no external hosts) listing the endpoints with example requests/responses you actually exercised.",
        "throwaway-ui": "Build a disposable, self-contained HTML UI over the work (artifact.type \"html\"): enough to click through what was built. It will be thrown away; optimize for showability, not polish.",
        slideshow: "Build a self-contained HTML slideshow (artifact.type \"html\") of what was done: goal, what changed, evidence it works, open risks. This is the showable summary for work with no runnable surface.",
    }[opts.gate.kind];
    return [
        `Developer preview (${opts.gate.kind}) for delegation node "${opts.logicalId}" (${opts.title}), attempt ${opts.attempt}. This is a REQUIRED backpressure gate: the artifact must build successfully.`,
        "",
        "--- PREVIEW BRIEF (declared before execution) ---",
        opts.gate.brief,
        "--- END PREVIEW BRIEF ---",
        "",
        kindBrief,
        "",
        "--- WHAT WAS EXECUTED (self-reports) ---",
        opts.execSummaries.length > 0 ? opts.execSummaries.join("\n\n") : "(planning-only node — summarize the subtree's completed work)",
        "--- END SELF-REPORTS ---",
        opts.feedback.length > 0
            ? `\n--- PREVIOUS PREVIEW FAILURE (fix it) ---\n${opts.feedback.join("\n\n")}\n--- END FAILURE ---`
            : "",
        "",
        "Set builtOk HONESTLY: true only if the artifact actually built/rendered. A false builtOk fails the node like a failed review and redelegates it with your summary folded in.",
        `Return JSON matching (logicalId "${opts.logicalId}", kind "${opts.gate.kind}"):`,
        zodSchemaToJsonExample(dcDevPreviewSchema),
    ].filter(Boolean).join("\n");
}

/**
 * End-of-run satisfaction poll form.
 * @returns {string}
 */
export function pollPrompt() {
    return [
        "The delegation run is complete. Rate it (1 = poor, 5 = excellent):",
        "",
        "1. Did the refined goal capture what you actually wanted?",
        "2. Did the plan and its previews/probes earn your trust before execution?",
        "3. Did the delivered work meet the success criteria?",
        "",
        "Submit JSON matching:",
        zodSchemaToJsonExample(dcPollSchema),
    ].join("\n");
}

/**
 * Answer form prompt for one question (shown by the durable human request;
 * the UI renders the dcQuestion row's form metadata alongside).
 * @param {{ question: Record<string, any> }} opts
 * @returns {string}
 */
export function answerPrompt(opts) {
    return [
        `Question ${opts.question.seq}: ${opts.question.question}`,
        "",
        JSON.stringify(opts.question, null, 2),
        "",
        `Recommended: ${opts.question.recommended} — ${opts.question.reason}`,
        'Submit your answer as JSON: a bare value (a string for select/text, true/false for confirm), e.g. "yes". It is folded into the question row as the accepted answer.',
    ].join("\n");
}

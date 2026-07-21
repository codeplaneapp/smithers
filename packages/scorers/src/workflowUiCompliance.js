import { createScorer } from "./createScorer.js";

/** @typedef {import("./WorkflowUiComplianceOptions.ts").WorkflowUiComplianceOptions} WorkflowUiComplianceOptions */
/** @typedef {import("./WorkflowUiComplianceOptions.ts").WorkflowUiComplianceReport} WorkflowUiComplianceReport */
/** @typedef {import("./WorkflowUiComplianceOptions.ts").WorkflowUiViolation} WorkflowUiViolation */

/**
 * Static design-system compliance grader for generated workflow UIs
 * (`.smithers/ui/<key>.tsx`). Encodes the authoring contract the create-ui
 * agents keep drifting from: compose the shipped component libraries instead
 * of hand-rolling markup, and always surface live agent feedback.
 *
 * Rules (each violation carries its rule id):
 * - `imports`        — import only from react + `smithers-orchestrator/gateway-react`,
 *                      `.../gateway-ui`, `.../ui` (plus relative modules).
 * - `shell`          — page chrome comes from `WorkflowUiShell` (or
 *                      `SimpleWorkflowDashboard` for the stock layout).
 * - `mount`          — the file mounts via `createGatewayReactRoot`.
 * - `live-chat`      — when the workflow has agent tasks (or
 *                      `requireNodeChat` is set), the UI must render
 *                      `NodeChatStream` so humans see the agents' live chat.
 * - `hand-rolled-colors` — no raw hex color literals; tint through components
 *                      and theme tokens so light/dark both work.
 * - `hand-rolled-pills`  — no `borderRadius: 999` pill re-implementations;
 *                      that's `StatusPill` / `Badge`.
 * - `hand-rolled-table`  — no raw `<table>` markup; use `Table` / `FleetTable`.
 *
 * Pure and deterministic: feed it source text (no filesystem access) so it
 * runs identically in unit tests, create-ui gate tasks, and `smithers eval`
 * assertions.
 *
 * @param {string} uiSource The UI module's source text.
 * @param {WorkflowUiComplianceOptions} [options]
 * @returns {WorkflowUiComplianceReport}
 */
export function gradeWorkflowUiSource(uiSource, options = {}) {
    /** @type {WorkflowUiViolation[]} */
    const violations = [];
    const code = stripComments(uiSource);

    const allowedSpecifier = /^(react(\/.*)?|smithers-orchestrator\/(gateway-react|gateway-ui|ui)|@smithers-orchestrator\/(gateway-react|gateway-ui|ui)(\/.*)?|\.\.?\/.*)$/;
    for (const match of code.matchAll(/(?:import|export)\s[^"']*?from\s*["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (!allowedSpecifier.test(specifier)) {
            violations.push({
                rule: "imports",
                detail: `Import from "${specifier}" — workflow UIs may only import react and the smithers-orchestrator gateway-react/gateway-ui/ui subpaths.`,
            });
        }
    }

    if (!/\b(WorkflowUiShell|SimpleWorkflowDashboard)\b/.test(code)) {
        violations.push({
            rule: "shell",
            detail: "No WorkflowUiShell (or SimpleWorkflowDashboard) — page chrome, theme css, and the header slots must come from the shipped shell.",
        });
    }

    if (!/\bcreateGatewayReactRoot\b/.test(code)) {
        violations.push({
            rule: "mount",
            detail: "Missing createGatewayReactRoot(<App />) mount.",
        });
    }

    const requireNodeChat = options.requireNodeChat ??
        (options.workflowSource !== undefined ? workflowHasAgentTasks(options.workflowSource) : false);
    if (requireNodeChat && !/\bNodeChatStream\b/.test(code)) {
        violations.push({
            rule: "live-chat",
            detail: "The workflow runs agent tasks but the UI never renders NodeChatStream — humans must be able to watch each agent's live chat.",
        });
    }

    for (const match of code.matchAll(/#(?:[0-9a-fA-F]{3}\b|[0-9a-fA-F]{6}\b|[0-9a-fA-F]{8}\b)/g)) {
        violations.push({
            rule: "hand-rolled-colors",
            detail: `Raw hex color ${match[0]} — use the shipped components/theme tokens so light and dark themes both work.`,
        });
    }

    if (/borderRadius:\s*999\b/.test(code)) {
        violations.push({
            rule: "hand-rolled-pills",
            detail: "borderRadius: 999 pill re-implementation — use StatusPill / Badge.",
        });
    }

    if (/<table\b/.test(code)) {
        violations.push({
            rule: "hand-rolled-table",
            detail: "Raw <table> markup — use Table (smithers-orchestrator/ui) or FleetTable (gateway-ui).",
        });
    }

    const rules = 7;
    const failedRules = new Set(violations.map((violation) => violation.rule)).size;
    return {
        passed: violations.length === 0,
        score: (rules - failedRules) / rules,
        violations,
    };
}

/**
 * Heuristic: does a workflow module run agent tasks? Agent tasks carry a
 * `prompt` (or `agent`/`codexGoal`-style helper) while deterministic tasks use
 * `computeFn`/`staticPayload` only.
 *
 * @param {string} workflowSource
 * @returns {boolean}
 */
export function workflowHasAgentTasks(workflowSource) {
    const code = stripComments(workflowSource);
    return /\bprompt\s*[=:{]/.test(code) || /\b(codexGoal|claudeGoal|agentGoal)\b/.test(code);
}

/**
 * Strip line/block comments so commented-out code and prose (which may
 * legitimately mention hex colors or `<table>`) never trip the rules.
 *
 * @param {string} source
 */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Scorer wrapper: expects `output` to be the generated UI source text (string
 * or `{ uiSource, workflowSource? }`), grades it with
 * {@link gradeWorkflowUiSource}, and reports the violations as the reason.
 */
export const workflowUiComplianceScorer = createScorer({
    id: "workflow-ui-compliance",
    name: "Workflow UI compliance",
    description: "Generated workflow UI composes the shipped design system (shell, pills, tables) and surfaces live agent chat via NodeChatStream.",
    score: async ({ output }) => {
        const payload = typeof output === "string" ? { uiSource: output } : /** @type {{ uiSource?: unknown, workflowSource?: unknown }} */ (output ?? {});
        const uiSource = typeof payload.uiSource === "string" ? payload.uiSource : "";
        if (!uiSource) {
            return { score: 0, reason: "No UI source to grade." };
        }
        const report = gradeWorkflowUiSource(uiSource, {
            ...(typeof payload.workflowSource === "string" ? { workflowSource: payload.workflowSource } : {}),
        });
        return {
            score: report.score,
            reason: report.passed
                ? "UI composes the shipped design system."
                : report.violations.map((violation) => `[${violation.rule}] ${violation.detail}`).join(" "),
            meta: { violations: report.violations },
        };
    },
});

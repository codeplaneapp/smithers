/**
 * Interactive init wizard entry point (pure logic + option builders).
 *
 * IMPORTANT: this module must stay free of any @opentui import so it is safe to
 * load on the eager CLI startup path (initCeremony.js imports it statically).
 * The OpenTUI (@opentui/react) render layer lives in ./interactiveInitUi.tsx and
 * is loaded via a dynamic import() inside runInteractiveInitFlow, so a platform
 * where the @opentui native binding fails to load degrades to
 * buildDefaultSelections() instead of crashing every smithers command.
 *
 * TODO (stretch): refactor into a proper smithers workflow so init is itself
 * dogfooded through the workflow runtime.
 */

import { homedir } from "node:os";
import type { AgentAvailability } from "../AgentAvailability.js";
import { detectAvailableAgents } from "../agent-detection.js";
import { skillTargets } from "../installCuratedSkill.js";
import { workflowManifestIds } from "../workflow-pack.js";

// ---------------------------------------------------------------------------
// Workflow list + labels
// ---------------------------------------------------------------------------
//
// The id list is DERIVED from WORKFLOW_MANIFEST (workflow-pack.js) so a workflow
// added to the pack never silently goes missing from this wizard. System
// workflows (durable `init`, `post-failure`) are intentionally excluded: they
// are internal plumbing the pack closure always installs, so offering a
// checkbox for them would be misleading. WORKFLOW_LABELS is a presentation-only
// map with a `?? id` fallback, so a missing label degrades gracefully.

const ALL_WORKFLOW_IDS: string[] = workflowManifestIds();

const WORKFLOW_LABELS: Record<string, string> = {
    vcs: "vcs – version control integration",
    implement: "implement – code + validate + review loop",
    "research-plan-implement": "research-plan-implement – research → plan → implement",
    review: "review – parallel multi-reviewer",
    plan: "plan – implementation planning",
    research: "research – deep context gathering",
    "ticket-create": "ticket-create – single ticket creator",
    "tickets-create": "tickets-create – bulk ticket creation",
    ralph: "ralph – exploratory refactoring",
    "improve-test-coverage": "improve-test-coverage – add missing tests",
    debug: "debug – validate + review loop",
    "grill-me": "grill-me – interactive Q&A for design decisions",
    "feature-enum": "feature-enum – feature inventory scanner",
    audit: "audit – feature-group auditor",
    mission: "mission – long-running multi-milestone orchestration",
    "workflow-skill": "workflow-skill – generate agent skill docs",
    kanban: "kanban – ticket-per-feature parallel work",
    hello: "hello – getting-started example",
    "create-workflow": "create-workflow – workflow builder (used by make-workflow)",
    "context-engineer": "context-engineer – context management",
    "route-task": "route-task – recommend a workflow for a task",
    "create-skill": "create-skill – scaffold a new agent skill",
    "extract-skill": "extract-skill – extract a skill from a coding session",
    "monitor-smithers": "monitor-smithers – live run monitor",
    monitor: "monitor – run + autofix loop",
    "triage-run": "triage-run – diagnose a failed run",
    "context-doctor": "context-doctor – CLAUDE.md health check",
    "backpressure-plan": "backpressure-plan – concurrency planning",
    "eval-author": "eval-author – write evals for workflows",
    "report-slideshow": "report-slideshow – generate a report deck",
    smithering: "smithering – build + monitor + self-improve loop",
    "make-workflow-tutorial": "make-workflow-tutorial – first-run workflow builder tutorial",
};

const AGENT_DOC_FILES: string[] = ["CLAUDE.md", "AGENTS.md"];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InitSelections = {
    selectedAgentSetup?: AgentSetupOptionId;
    selectedWorkflows: string[];
    selectedSkillTargets: string[];
    selectedAgentDocs: string[];
};

export type AgentSetupOptionId = "openrouter" | "claude" | "codex" | "opencode" | "custom";
export type AgentSetupOption = { id: AgentSetupOptionId; label: string; detail: string };
export type WorkflowOption = { id: string; label: string };
export type SkillOption = { id: string; label: string };
export type AgentDocOption = { filename: string; label: string };

// ---------------------------------------------------------------------------
// Pure option builders (unit-testable without a TTY)
// ---------------------------------------------------------------------------

/** All installable workflow options with human-readable labels. */
export function buildWorkflowOptions(): WorkflowOption[] {
    return ALL_WORKFLOW_IDS.map((id) => ({ id, label: WORKFLOW_LABELS[id] ?? id }));
}

/** Agent setup paths shown when no usable agent is detected. */
export function buildAgentSetupOptions(): AgentSetupOption[] {
    return [
        {
            id: "openrouter",
            label: "OpenRouter API key",
            detail: "Set OPENROUTER_API_KEY. Smithers uses OpenAIAgent with the OpenRouter base URL; first run errors loudly until the key exists.",
        },
        {
            id: "claude",
            label: "Claude Code CLI",
            detail: "Install the claude CLI, run claude, then /login. Smithers will uncomment the provider after detection succeeds.",
        },
        {
            id: "codex",
            label: "Codex CLI / OpenAI key",
            detail: "Install the codex CLI and log in, or set OPENAI_API_KEY for Codex-backed runs.",
        },
        {
            id: "opencode",
            label: "OpenCode CLI / provider key",
            detail: "Install opencode and authenticate, or set one of its provider API keys.",
        },
        {
            id: "custom",
            label: "Custom AgentLike adapter",
            detail: "Scaffold .smithers/agents/custom.ts. Implement generate(args) so it returns the assistant text for a task.",
        },
    ];
}

/** Skill install targets (agent IDs that can receive the smithers skill). */
export function buildSkillOptions(env: NodeJS.ProcessEnv = process.env): SkillOption[] {
    const homeDir = env.HOME ?? homedir();
    return skillTargets(homeDir).map((t) => ({ id: t.id, label: t.displayName }));
}

/** Agent doc files that can receive the workflow guidance block. */
export function buildAgentDocOptions(): AgentDocOption[] {
    return AGENT_DOC_FILES.map((f) => ({ filename: f, label: f }));
}

/**
 * Mapping from the flat initCeremony selections to the InitOptions fields
 * accepted by initWorkflowPack.  Pure function used in tests.
 */
export function selectionsToPackOptions(sel: InitSelections): {
    selectedWorkflows: string[];
    selectedSkillTargets: string[];
    selectedAgentDocs: string[];
    scaffoldCustomAgent: boolean;
} {
    return {
        selectedWorkflows: sel.selectedWorkflows,
        selectedSkillTargets: sel.selectedSkillTargets,
        selectedAgentDocs: sel.selectedAgentDocs,
        scaffoldCustomAgent: sel.selectedAgentSetup === "custom",
    };
}

/**
 * Force a set of workflow ids into a selection (union, de-duplicated), so a
 * caller that REQUIRES certain workflows regardless of what the wizard left
 * checked always gets them installed. `smithers init "<task>"` uses this to keep
 * `create-workflow` in the pack even if the user unchecked it, since the prompt
 * is an explicit request for the builder and the post-init dispatch would
 * otherwise fail with RUN_NOT_FOUND. Pure; unit-tested.
 */
export function withRequiredWorkflows(
    sel: InitSelections,
    requiredWorkflows: readonly string[] = [],
): InitSelections {
    if (requiredWorkflows.length === 0) return sel;
    return {
        ...sel,
        selectedWorkflows: Array.from(new Set([...sel.selectedWorkflows, ...requiredWorkflows])),
    };
}

/** Default selections: everything checked, all workflows, all skill targets. */
export function buildDefaultSelections(env: NodeJS.ProcessEnv = process.env): InitSelections {
    return {
        selectedWorkflows: ALL_WORKFLOW_IDS.slice(),
        selectedSkillTargets: buildSkillOptions(env).map((s) => s.id),
        selectedAgentDocs: AGENT_DOC_FILES.slice(),
    };
}

// ---------------------------------------------------------------------------
// Shared types (consumed by ./interactiveInitUi.tsx)
// ---------------------------------------------------------------------------

export type CheckItem = { id: string; label: string; checked: boolean; detail?: string };
export type WizardStep = "agent" | "workflows" | "skills";

// ---------------------------------------------------------------------------
// Agent detection message builder
// ---------------------------------------------------------------------------

function buildNoAgentsMessage(detections: AgentAvailability[]): string {
    const lines: string[] = [];
    if (detections.length > 0) {
        lines.push("Detected agents and why they are unavailable:");
        for (const d of detections) {
            if (d.deprecated) continue;
            const reason = d.unusableReasons?.[0] ?? "unavailable";
            lines.push(`  ○ ${d.displayName}: ${reason}`);
        }
        lines.push("");
    }
    lines.push(
        "Choose the setup path you want. Smithers still scaffolds a default OpenRouter-backed AgentLike so init never fails here.",
        "AgentLike contract: implement generate(args) and return the assistant text for the task.",
    );
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the interactive init wizard (OpenTUI React full-screen).
 * Returns the user's selections, or null if they cancelled.
 * Falls back to buildDefaultSelections on OpenTUI load failure.
 *
 * Must only be called when both stdin and stdout are TTYs (resolveInitMode
 * will have already verified this).
 */
export async function runInteractiveInitFlow(
    opts: {
        env?: NodeJS.ProcessEnv;
        /** Injectable OpenTUI loader (tests exercise the degrade paths without a PTY). */
        loadRenderer?: () => Promise<typeof import("./interactiveInitUi.js")>;
    } = {},
): Promise<InitSelections | null> {
    const env = opts.env ?? process.env;
    const detections = detectAvailableAgents(env);
    const usable = detections.filter((d) => !d.deprecated && d.usable);
    const noAgents = usable.length === 0;

    const workflowItems: CheckItem[] = buildWorkflowOptions().map((o) => ({
        id: o.id,
        label: o.label,
        checked: true,
    }));

    const skillItems: CheckItem[] = [
        ...buildSkillOptions(env).map((o) => ({
            id: `skill:${o.id}`,
            label: `smithers skill → ${o.label}`,
            checked: true,
        })),
        ...buildAgentDocOptions().map((o) => ({
            id: `doc:${o.filename}`,
            label: `workflow guidance → ${o.filename}`,
            checked: true,
        })),
    ];

    const steps: WizardStep[] = noAgents
        ? ["agent", "workflows", "skills"]
        : ["workflows", "skills"];

    const noAgentsMessage = buildNoAgentsMessage(detections);
    const agentItems: CheckItem[] = buildAgentSetupOptions().map((o, idx) => ({
        id: o.id,
        label: o.label,
        detail: o.detail,
        checked: idx === 0,
    }));

    // Load the OpenTUI render layer lazily. A missing/failing @opentui native
    // binding must degrade THIS path to defaults, never crash the whole CLI —
    // so the import lives here (dynamic), not at module top.
    const loadRenderer = opts.loadRenderer ?? (() => import("./interactiveInitUi.js"));
    let renderInitWizard: typeof import("./interactiveInitUi.js").renderInitWizard;
    try {
        ({ renderInitWizard } = await loadRenderer());
    } catch (err) {
        // No selection UI: tell the user why (a broken native binding otherwise
        // looks identical to them confirming every default) before proceeding.
        process.stderr.write(`[smithers:init] interactive wizard unavailable (${errMessage(err)}); installing defaults\n`);
        return buildDefaultSelections(env);
    }

    try {
        return await renderInitWizard({ steps, workflowItems, skillItems, agentItems, noAgentsMessage });
    } catch (err) {
        // Renderer failed to initialize (non-PTY environment, missing dylib).
        // Fall back to all-selected defaults so init proceeds normally.
        process.stderr.write(`[smithers:init] interactive wizard unavailable (${errMessage(err)}); installing defaults\n`);
        return buildDefaultSelections(env);
    }
}

/** @internal Normalize an unknown thrown value to a short message. */
function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

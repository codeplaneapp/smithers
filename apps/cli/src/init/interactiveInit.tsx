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
import { resolve } from "node:path";
import type { AgentAvailability } from "../AgentAvailability.js";
import { detectAvailableAgents } from "../agent-detection.js";
import { loadSkillDeselections, skillTargets } from "../installCuratedSkill.js";
import { loadPackSelections, workflowManifestIds } from "../workflow-pack.js";

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

/**
 * Presentation-only grouping for the wizard's workflow list. Ordering matters:
 * "Start here" puts hello/create-workflow on top for first-timers instead of
 * burying them in an alphabet-of-32 wall. Any manifest id missing from every
 * group lands in the trailing "More" bucket, so a newly added workflow can
 * never silently vanish from the wizard.
 */
const WORKFLOW_GROUPS: ReadonlyArray<{ title: string; ids: readonly string[] }> = [
    { title: "Start here", ids: ["hello", "create-workflow", "make-workflow-tutorial", "route-task"] },
    { title: "Build & ship", ids: ["implement", "research-plan-implement", "plan", "research", "review", "debug", "improve-test-coverage", "ralph", "mission", "kanban", "smithering"] },
    { title: "Plan & organize", ids: ["grill-me", "ticket-create", "tickets-create", "feature-enum", "audit", "backpressure-plan", "context-engineer", "context-doctor"] },
    { title: "Operate & monitor", ids: ["triage-run", "vcs"] },
    { title: "Meta & skills", ids: ["workflow-skill", "create-skill", "extract-skill", "eval-author", "report-slideshow"] },
];

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
export type WorkflowOption = { id: string; label: string; header?: string };
export type SkillOption = { id: string; label: string };
export type AgentDocOption = { filename: string; label: string };

// ---------------------------------------------------------------------------
// Pure option builders (unit-testable without a TTY)
// ---------------------------------------------------------------------------

/**
 * All installable workflow options with human-readable labels, in wizard
 * display order (grouped, "Start here" first). The first option of each group
 * carries a `header` the renderer prints above it.
 */
export function buildWorkflowOptions(): WorkflowOption[] {
    const remaining = new Set(ALL_WORKFLOW_IDS);
    const options: WorkflowOption[] = [];
    for (const group of WORKFLOW_GROUPS) {
        let first = true;
        for (const id of group.ids) {
            if (!remaining.delete(id)) continue; // not in this manifest build
            options.push({ id, label: WORKFLOW_LABELS[id] ?? id, ...(first ? { header: group.title } : {}) });
            first = false;
        }
    }
    let firstLeftover = true;
    for (const id of ALL_WORKFLOW_IDS) {
        if (!remaining.has(id)) continue;
        options.push({ id, label: WORKFLOW_LABELS[id] ?? id, ...(firstLeftover ? { header: "More" } : {}) });
        firstLeftover = false;
    }
    return options;
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

/**
 * What the user opted OUT of last time, so a re-init's wizard (and the degrade
 * path) starts from their previous choices instead of all-checked — confirming
 * an all-checked list persists as "select everything" and silently wipes the
 * earlier deselections. Pure lookups; every source is best-effort-empty when
 * absent (fresh init = nothing deselected).
 */
export function loadPersistedDeselections(
    env: NodeJS.ProcessEnv = process.env,
    packRoot: string = resolve(process.cwd(), ".smithers"),
): { workflows: Set<string>; skillTargets: Set<string>; agentDocs: Set<string> } {
    const pack = loadPackSelections(packRoot);
    const homeDir = env.HOME ?? homedir();
    let skillOptOuts: string[] = [];
    try {
        skillOptOuts = loadSkillDeselections(homeDir);
    } catch {
        /* best-effort */
    }
    return {
        workflows: new Set(pack.deselectedWorkflows),
        skillTargets: new Set(skillOptOuts),
        agentDocs: new Set(pack.deselectedAgentDocs.map((name) => name.toLowerCase())),
    };
}

/**
 * Default selections: everything checked except what the user deselected in a
 * previous init (persisted in pack-selections.json + the skill opt-out marker).
 */
export function buildDefaultSelections(
    env: NodeJS.ProcessEnv = process.env,
    packRoot?: string,
): InitSelections {
    const deselected = loadPersistedDeselections(env, packRoot);
    return {
        selectedWorkflows: ALL_WORKFLOW_IDS.filter((id) => !deselected.workflows.has(id)),
        selectedSkillTargets: buildSkillOptions(env).map((s) => s.id).filter((id) => !deselected.skillTargets.has(id)),
        selectedAgentDocs: AGENT_DOC_FILES.filter((f) => !deselected.agentDocs.has(f.toLowerCase())),
    };
}

// ---------------------------------------------------------------------------
// Shared types (consumed by ./interactiveInitUi.tsx)
// ---------------------------------------------------------------------------

export type CheckItem = { id: string; label: string; checked: boolean; detail?: string; header?: string };
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
        /** Pack root holding pack-selections.json (defaults to ./.smithers). */
        packRoot?: string;
        /** Injectable OpenTUI loader (tests exercise the degrade paths without a PTY). */
        loadRenderer?: () => Promise<typeof import("./interactiveInitUi.js")>;
    } = {},
): Promise<InitSelections | null> {
    const env = opts.env ?? process.env;
    const detections = detectAvailableAgents(env);
    const usable = detections.filter((d) => !d.deprecated && d.usable);
    const noAgents = usable.length === 0;

    // Start from the user's previous choices, not all-checked: confirming an
    // all-checked wizard would persist as "select everything" and wipe the
    // deselections a prior interactive init recorded.
    const deselected = loadPersistedDeselections(env, opts.packRoot);

    const workflowItems: CheckItem[] = buildWorkflowOptions().map((o) => ({
        id: o.id,
        label: o.label,
        checked: !deselected.workflows.has(o.id),
        ...(o.header ? { header: o.header } : {}),
    }));

    const skillItems: CheckItem[] = [
        ...buildSkillOptions(env).map((o) => ({
            id: `skill:${o.id}`,
            label: `smithers skill → ${o.label}`,
            checked: !deselected.skillTargets.has(o.id),
        })),
        ...buildAgentDocOptions().map((o) => ({
            id: `doc:${o.filename}`,
            label: `workflow guidance → ${o.filename}`,
            checked: !deselected.agentDocs.has(o.filename.toLowerCase()),
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
        return buildDefaultSelections(env, opts.packRoot);
    }

    try {
        return await renderInitWizard({ steps, workflowItems, skillItems, agentItems, noAgentsMessage });
    } catch (err) {
        // Renderer failed to initialize (non-PTY environment, missing dylib).
        // Fall back to the persisted-default selections so init proceeds normally.
        process.stderr.write(`[smithers:init] interactive wizard unavailable (${errMessage(err)}); installing defaults\n`);
        return buildDefaultSelections(env, opts.packRoot);
    }
}

/** @internal Normalize an unknown thrown value to a short message. */
function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

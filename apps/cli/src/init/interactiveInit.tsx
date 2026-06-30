/** @jsxImportSource @opentui/react */

/**
 * Interactive init wizard built on @opentui/react (spike result: viable=true).
 * Renders a full-screen TUI for à-la-carte workflow and skill selection before
 * initWorkflowPack runs.  Falls back to buildDefaultSelections() when OpenTUI
 * fails to load (non-TTY, missing native lib, etc.).
 *
 * TODO (stretch): refactor into a proper smithers workflow so init is itself
 * dogfooded through the workflow runtime.
 */

import React, { useState, useRef } from "react";
import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { homedir } from "node:os";
import type { AgentAvailability } from "../AgentAvailability.js";
import { detectAvailableAgents } from "../agent-detection.js";
import { skillTargets } from "../installCuratedSkill.js";

// ---------------------------------------------------------------------------
// Workflow manifest (mirrors WORKFLOW_MANIFEST in workflow-pack.js)
// ---------------------------------------------------------------------------

const ALL_WORKFLOW_IDS: string[] = [
    "vcs", "implement", "research-plan-implement", "review", "plan", "research",
    "ticket-create", "tickets-create", "ralph", "improve-test-coverage", "debug",
    "grill-me", "feature-enum", "audit", "mission", "workflow-skill", "kanban",
    "hello", "create-workflow", "context-engineer", "route-task", "create-skill",
    "extract-skill", "monitor-smithers", "monitor", "triage-run", "context-doctor",
    "backpressure-plan", "eval-author", "report-slideshow", "smithering",
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
    "monitor-smithers": "monitor-smithers – live run monitor",
    monitor: "monitor – run + autofix loop",
    "triage-run": "triage-run – diagnose a failed run",
    "context-doctor": "context-doctor – CLAUDE.md health check",
    "backpressure-plan": "backpressure-plan – concurrency planning",
    "eval-author": "eval-author – write evals for workflows",
    "report-slideshow": "report-slideshow – generate a report deck",
    smithering: "smithering – build + monitor + self-improve loop",
};

const AGENT_DOC_FILES: string[] = ["CLAUDE.md", "AGENTS.md"];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InitSelections = {
    selectedWorkflows: string[];
    selectedSkillTargets: string[];
    selectedAgentDocs: string[];
};

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
} {
    return {
        selectedWorkflows: sel.selectedWorkflows,
        selectedSkillTargets: sel.selectedSkillTargets,
        selectedAgentDocs: sel.selectedAgentDocs,
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
// Internal types and helpers
// ---------------------------------------------------------------------------

type CheckItem = { id: string; label: string; checked: boolean };
type WizardStep = "agent" | "workflows" | "skills";

function formatRow(label: string, isActive: boolean, isChecked: boolean): string {
    const arrow = isActive ? "▶ " : "  ";
    const box = isChecked ? "[✓] " : "[ ] ";
    return arrow + box + label;
}

// ---------------------------------------------------------------------------
// OpenTUI React wizard component
// ---------------------------------------------------------------------------

type WizardRef = {
    stepIdx: number;
    cursor: number;
    scrollOff: number;
    wfItems: CheckItem[];
    skItems: CheckItem[];
    visible: number;
    steps: WizardStep[];
};

type WizardProps = {
    steps: WizardStep[];
    workflowItems: CheckItem[];
    skillItems: CheckItem[];
    noAgentsMessage: string;
    onConfirm: (selections: InitSelections) => void;
    onCancel: () => void;
};

function InitWizard({ steps, workflowItems: initWf, skillItems: initSk, noAgentsMessage, onConfirm, onCancel }: WizardProps) {
    const { height } = useTerminalDimensions();
    const visible = Math.max(5, height - 12);

    const [stepIdx, setStepIdx] = useState(0);
    const [wfItems, setWfItems] = useState<CheckItem[]>(initWf);
    const [skItems, setSkItems] = useState<CheckItem[]>(initSk);
    const [cursor, setCursor] = useState(0);
    const [scrollOff, setScrollOff] = useState(0);

    // Ref keeps the keyboard handler free of stale closures
    const stateRef = useRef<WizardRef>({ stepIdx, cursor, scrollOff, wfItems, skItems, visible, steps });
    stateRef.current = { stepIdx, cursor, scrollOff, wfItems, skItems, visible, steps };

    const step = steps[stepIdx] ?? "workflows";
    const isLastStep = stepIdx === steps.length - 1;
    const items = step === "workflows" ? wfItems : step === "skills" ? skItems : [];
    const checkedCount = items.filter((i) => i.checked).length;
    const visibleItems = items.slice(scrollOff, scrollOff + visible);

    useKeyboard((key: KeyEvent) => {
        const s = stateRef.current;
        const st = s.steps[s.stepIdx] ?? "workflows";

        // Cancel always works
        if (key.name === "escape" || (key.ctrl && key.name === "c")) {
            onCancel();
            return;
        }

        // Agent info step: just press Enter to proceed
        if (st === "agent") {
            if (key.name === "return") {
                setStepIdx(s.stepIdx + 1);
                setCursor(0);
                setScrollOff(0);
            }
            return;
        }

        const itms = st === "workflows" ? s.wfItems : s.skItems;

        if (key.name === "up" || (key.name === "k" && !key.ctrl && !key.meta)) {
            const next = Math.max(0, s.cursor - 1);
            setCursor(next);
            setScrollOff(next < s.scrollOff ? next : s.scrollOff);
        } else if (key.name === "down" || (key.name === "j" && !key.ctrl && !key.meta)) {
            const next = Math.min(itms.length - 1, s.cursor + 1);
            setCursor(next);
            setScrollOff(next >= s.scrollOff + s.visible ? next - s.visible + 1 : s.scrollOff);
        } else if (key.name === "space") {
            const c = s.cursor;
            if (st === "workflows") {
                setWfItems((prev) => prev.map((item, i) => (i === c ? { ...item, checked: !item.checked } : item)));
            } else {
                setSkItems((prev) => prev.map((item, i) => (i === c ? { ...item, checked: !item.checked } : item)));
            }
        } else if (key.name === "a" && !key.ctrl) {
            if (st === "workflows") {
                setWfItems((prev) => {
                    const allChecked = prev.every((i) => i.checked);
                    return prev.map((i) => ({ ...i, checked: !allChecked }));
                });
            } else {
                setSkItems((prev) => {
                    const allChecked = prev.every((i) => i.checked);
                    return prev.map((i) => ({ ...i, checked: !allChecked }));
                });
            }
        } else if (key.name === "return") {
            if (s.stepIdx < s.steps.length - 1) {
                setStepIdx(s.stepIdx + 1);
                setCursor(0);
                setScrollOff(0);
            } else {
                // Final confirm: collect selections and exit
                const wf = s.wfItems.filter((i) => i.checked).map((i) => i.id);
                const sk = s.skItems
                    .filter((i) => i.id.startsWith("skill:") && i.checked)
                    .map((i) => i.id.slice("skill:".length));
                const docs = s.skItems
                    .filter((i) => i.id.startsWith("doc:") && i.checked)
                    .map((i) => i.id.slice("doc:".length));
                onConfirm({ selectedWorkflows: wf, selectedSkillTargets: sk, selectedAgentDocs: docs });
            }
        }
    });

    // -------------------------------------------------------------------------
    // Agent info screen (no usable agents detected)
    // -------------------------------------------------------------------------
    if (step === "agent") {
        return (
            <box width="100%" height="100%" flexDirection="column" padding={2}>
                <text content="smithers init — agent setup" fg="#ffcc00" />
                <text content="" />
                <text content="No coding agent detected on this machine." fg="#ff8888" />
                <text content="" />
                <text content={noAgentsMessage} fg="#cccccc" wrapMode="word" />
                <text content="" />
                <text content="Press Enter to continue with scaffolding." fg="#666666" />
                <text content="Smithers will emit an actionable error on the first workflow run." fg="#666666" />
            </box>
        );
    }

    // -------------------------------------------------------------------------
    // Multiselect screens (workflows / skills)
    // -------------------------------------------------------------------------
    const stepTitle = step === "workflows"
        ? `Select workflows to install  (${checkedCount} / ${items.length} selected)`
        : `Select skills + agent docs  (${checkedCount} / ${items.length} selected)`;

    const scrollInfo = items.length > visible
        ? `  [${scrollOff + 1}–${Math.min(scrollOff + visible, items.length)}/${items.length}]`
        : "";

    const nextLabel = isLastStep ? "✓ confirm" : "→ next";
    const footer = `  ↑↓ / jk navigate   space toggle   a toggle-all   enter ${nextLabel}   esc cancel${scrollInfo}`;

    return (
        <box width="100%" height="100%" flexDirection="column" padding={1}>
            <text content={`  smithers init  —  ${stepTitle}`} fg="#00cccc" />
            <text content="" />
            {visibleItems.map((item, idx) => {
                const globalIdx = idx + scrollOff;
                return (
                    <text
                        key={item.id}
                        content={formatRow(item.label, globalIdx === cursor, item.checked)}
                        fg={globalIdx === cursor ? "#ffffff" : "#888888"}
                    />
                );
            })}
            <text content="" />
            <text content={footer} fg="#555555" />
        </box>
    );
}

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
        "Options to add an agent:",
        "  • Claude Code   → install `claude` CLI, run `claude` then `/login`",
        "  • Codex         → install `codex` CLI, or set OPENAI_API_KEY",
        "  • OpenCode      → install `opencode` CLI with any supported API key",
        "  • OpenRouter    → set OPENROUTER_API_KEY (uses OpenAI-compatible SDK agent)",
        "",
        "Custom adapter: implement { generate(prompt): Promise<string> } (AgentLike contract).",
        "Run `smithers agents add` after init to register accounts interactively.",
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
    opts: { env?: NodeJS.ProcessEnv } = {},
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

    return new Promise<InitSelections | null>((resolve) => {
        createCliRenderer({ exitOnCtrlC: false, clearOnShutdown: true })
            .then((renderer) => {
                const root = createRoot(renderer);

                const handleConfirm = (sels: InitSelections) => {
                    root.unmount();
                    renderer.destroy();
                    resolve(sels);
                };

                const handleCancel = () => {
                    root.unmount();
                    renderer.destroy();
                    resolve(null);
                };

                root.render(
                    <InitWizard
                        steps={steps}
                        workflowItems={workflowItems}
                        skillItems={skillItems}
                        noAgentsMessage={noAgentsMessage}
                        onConfirm={handleConfirm}
                        onCancel={handleCancel}
                    />,
                );
            })
            .catch(() => {
                // OpenTUI failed to initialize (e.g. non-PTY environment, missing dylib).
                // Fall back to all-selected defaults so init proceeds normally.
                resolve(buildDefaultSelections(env));
            });
    });
}

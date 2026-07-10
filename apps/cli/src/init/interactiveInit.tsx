/**
 * Default selections for `smithers init`.
 *
 * Interactive init asks exactly ONE question — which coding agent the user
 * prefers (see ./selectPreferredAgent.js). Workflows, skill targets, and
 * agent docs install with defaults: everything, minus whatever a previous
 * init persisted as deselected (pack-selections.json + the skill opt-out
 * marker). These helpers build and map those defaults; they are pure and
 * unit-tested without a TTY.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadSkillDeselections, skillTargets } from "../installCuratedSkill.js";
import { loadPackSelections, workflowManifestIds } from "../workflow-pack.js";

// The id list is DERIVED from WORKFLOW_MANIFEST (workflow-pack.js) so a
// workflow added to the pack is never silently dropped from the defaults.
// System workflows (durable `init`, `post-failure`) are excluded: the pack
// closure always installs them.
const ALL_WORKFLOW_IDS: string[] = workflowManifestIds();

const AGENT_DOC_FILES: string[] = ["CLAUDE.md", "AGENTS.md"];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InitSelections = {
    selectedWorkflows: string[];
    selectedSkillTargets: string[];
    selectedAgentDocs: string[];
};

export type SkillOption = { id: string; label: string };

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

/** Skill install targets (agent IDs that can receive the smithers skill). */
export function buildSkillOptions(env: NodeJS.ProcessEnv = process.env): SkillOption[] {
    const homeDir = env.HOME ?? homedir();
    return skillTargets(homeDir).map((t) => ({ id: t.id, label: t.displayName }));
}

/**
 * Mapping from init selections to the InitOptions fields accepted by
 * initWorkflowPack. Pure function used in tests.
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

/**
 * Force a set of workflow ids into a selection (union, de-duplicated), so a
 * caller that REQUIRES certain workflows regardless of persisted deselections
 * always gets them installed. `smithers init "<task>"` uses this to keep
 * `create-workflow` in the pack, since the prompt is an explicit request for
 * the builder and the post-init dispatch would otherwise fail with
 * RUN_NOT_FOUND. Pure; unit-tested.
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
 * What the user opted OUT of last time, so a re-init starts from their
 * previous choices instead of all-selected. Pure lookups; every source is
 * best-effort-empty when absent (fresh init = nothing deselected).
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
 * Default selections: everything, except what the user deselected in a
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

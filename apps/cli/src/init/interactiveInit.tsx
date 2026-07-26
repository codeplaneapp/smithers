/**
 * Default selections for `smithers init`.
 *
 * Interactive init asks exactly ONE question — which coding agent the user
 * prefers (see ./selectPreferredAgent.js). The curated workflow set is fixed;
 * only skill targets and agent-doc integration retain user choices.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadSkillDeselections, skillTargets } from "../installCuratedSkill.js";
import { loadPackSelections } from "../workflow-pack.js";

const AGENT_DOC_FILES: string[] = ["CLAUDE.md", "AGENTS.md"];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InitSelections = {
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
  selectedSkillTargets: string[];
  selectedAgentDocs: string[];
} {
  return {
    selectedSkillTargets: sel.selectedSkillTargets,
    selectedAgentDocs: sel.selectedAgentDocs,
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
): { skillTargets: Set<string>; agentDocs: Set<string> } {
  const pack = loadPackSelections(packRoot);
  const homeDir = env.HOME ?? homedir();
  let skillOptOuts: string[] = [];
  try {
    skillOptOuts = loadSkillDeselections(homeDir);
  } catch {
    /* best-effort */
  }
  return {
    skillTargets: new Set(skillOptOuts),
    agentDocs: new Set(pack.deselectedAgentDocs.map((name) => name.toLowerCase())),
  };
}

/**
 * Default selections: everything, except what the user deselected in a
 * previous init (persisted in pack-selections.json + the skill opt-out marker).
 */
export function buildDefaultSelections(env: NodeJS.ProcessEnv = process.env, packRoot?: string): InitSelections {
  const deselected = loadPersistedDeselections(env, packRoot);
  return {
    selectedSkillTargets: buildSkillOptions(env)
      .map((s) => s.id)
      .filter((id) => !deselected.skillTargets.has(id)),
    selectedAgentDocs: AGENT_DOC_FILES.filter((f) => !deselected.agentDocs.has(f.toLowerCase())),
  };
}

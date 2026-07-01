import type { WorkflowSourceType } from "./WorkflowSourceType.ts";

export type DiscoveredWorkflow = {
    id: string;
    metadataVersion: 1;
    displayName: string;
    /** Discovery tier this workflow came from, highest precedence first: `explicit` (`$SMITHERS_WORKFLOW_PATHS`), `curated` (`<pack>/workflows/curated/active`), `local` (a repo's `.smithers`), or `global` (user-level `~/.smithers`). Higher tiers shadow lower ones on id collision. */
    scope: "explicit" | "curated" | "local" | "global";
    sourceType: WorkflowSourceType;
    description: string;
    tags: string[];
    aliases: string[];
    /** Capability gating (parallel to eliza skills). Empty arrays mean no requirement. */
    requiredOs: string[];
    requiredBins: string[];
    requiredEnv: string[];
    /** When true, the workflow is hidden from model-facing prompts/skill listings (still runnable explicitly). */
    disableModelInvocation: boolean;
    /** When false, the workflow cannot be invoked as a user command. Defaults to true. */
    userInvocable: boolean;
    /** False when a `required-*` prerequisite is unmet; the workflow is still listed but flagged. */
    eligible: boolean;
    /** Human-readable reasons the workflow is ineligible (empty when eligible). */
    ineligibleReasons: string[];
    entryFile: string;
    path: string;
};

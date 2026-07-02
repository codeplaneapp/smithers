/**
 * Shared types for the elizaOS-conventions workflow authoring layer.
 *
 * Mirrors elizaOS Skill/Plugin shapes so callers who know elizaOS conventions
 * can author, load, and register Smithers workflows with familiar patterns.
 */

import type { SmithersWorkflow } from "smithers-orchestrator";

/**
 * The parsed frontmatter block from a workflow file.
 * Uses `---`-fenced YAML blocks, matching the elizaOS Skill frontmatter convention.
 */
export interface WorkflowFrontmatter {
  name?: string;
  description?: string;
  tags?: string[];
  aliases?: string[];
  "disable-model-invocation"?: boolean;
  "user-invocable"?: boolean;
  system?: boolean;
  [key: string]: unknown;
}

/**
 * A fully-resolved workflow definition ready for registration.
 * Analogous to an elizaOS Skill object.
 */
export interface WorkflowDefinition {
  /** Unique slug name (kebab-case). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Freeform tags for grouping/filtering. */
  tags?: string[];
  /** Alternative names that trigger this workflow. */
  aliases?: string[];
  /** SemVer string, if declared in frontmatter. */
  version?: string;
  /** When true, the workflow system should not invoke a model automatically. */
  disableModelInvocation?: boolean;
  /** When true, the workflow is internal plumbing hidden from default listings and prompt sections. */
  system?: boolean;
  /** Absolute path to the source file, when loaded from disk. */
  filePath?: string;
  /** Base directory the workflow was loaded from. */
  baseDir?: string;
  /** Raw source text of the workflow file. */
  source?: string;
  /** The actual Smithers workflow (the object with `.build` and `.opts`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workflow: SmithersWorkflow<any>;
}

/** One entry emitted by the loader — pairs a resolved definition with raw metadata. */
export interface WorkflowEntry {
  workflow: WorkflowDefinition;
  frontmatter: WorkflowFrontmatter;
  metadata: Record<string, unknown>;
}

/** Severity of a loader diagnostic. */
export type WorkflowDiagnosticType = "warning" | "error" | "collision";

/** A loader diagnostic — warning, error, or name-collision notice. */
export interface WorkflowDiagnostic {
  type: WorkflowDiagnosticType;
  message: string;
  path?: string;
  collision?: {
    existing: WorkflowDefinition;
    incoming: WorkflowDefinition;
  };
}

/** Returned by `loadWorkflows` and `loadWorkflowsFromDir`. */
export interface LoadWorkflowsResult {
  workflows: WorkflowDefinition[];
  diagnostics: WorkflowDiagnostic[];
}

/** Options accepted by `loadWorkflows`. */
export interface LoadWorkflowsOptions {
  /** Working directory for resolving relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Explicit list of workflow file paths to load. */
  workflowPaths?: string[];
  /** Whether to include built-in bundled workflows. */
  includeDefaults?: boolean;
  /** Directory of bundled workflows. */
  bundledDir?: string;
  /** Directory of managed (installed) workflows. */
  managedDir?: string;
}

/**
 * A workflow plugin — a named collection of WorkflowDefinitions.
 * Mirrors the elizaOS Plugin shape (`name`, `description`, collection of capabilities).
 */
export interface WorkflowPlugin {
  name: string;
  description: string;
  workflows: WorkflowDefinition[];
}

/**
 * Minimal elizaOS Skill shape.
 * Used by `toSkill` as the return type when @elizaos/core does not export Skill.
 */
export interface ElizaSkill {
  name: string;
  description: string;
  tags?: string[];
  aliases?: string[];
}

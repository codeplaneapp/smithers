import { SmithersWorkflow } from 'smithers-orchestrator';

/**
 * Shared types for the elizaOS-conventions workflow authoring layer.
 *
 * Mirrors elizaOS Skill/Plugin shapes so callers who know elizaOS conventions
 * can author, load, and register Smithers workflows with familiar patterns.
 */

/**
 * The parsed frontmatter block from a workflow file.
 * Uses `---`-fenced YAML blocks, matching the elizaOS Skill frontmatter convention.
 */
interface WorkflowFrontmatter {
    name?: string;
    description?: string;
    tags?: string[];
    aliases?: string[];
    "disable-model-invocation"?: boolean;
    "user-invocable"?: boolean;
    [key: string]: unknown;
}
/**
 * A fully-resolved workflow definition ready for registration.
 * Analogous to an elizaOS Skill object.
 */
interface WorkflowDefinition {
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
    /** Absolute path to the source file, when loaded from disk. */
    filePath?: string;
    /** Base directory the workflow was loaded from. */
    baseDir?: string;
    /** Raw source text of the workflow file. */
    source?: string;
    /** The actual Smithers workflow (the object with `.build` and `.opts`). */
    workflow: SmithersWorkflow<any>;
}
/** One entry emitted by the loader — pairs a resolved definition with raw metadata. */
interface WorkflowEntry {
    workflow: WorkflowDefinition;
    frontmatter: WorkflowFrontmatter;
    metadata: Record<string, unknown>;
}
/** Severity of a loader diagnostic. */
type WorkflowDiagnosticType = "warning" | "error" | "collision";
/** A loader diagnostic — warning, error, or name-collision notice. */
interface WorkflowDiagnostic {
    type: WorkflowDiagnosticType;
    message: string;
    path?: string;
    collision?: {
        existing: WorkflowDefinition;
        incoming: WorkflowDefinition;
    };
}
/** Returned by `loadWorkflows` and `loadWorkflowsFromDir`. */
interface LoadWorkflowsResult {
    workflows: WorkflowDefinition[];
    diagnostics: WorkflowDiagnostic[];
}
/** Options accepted by `loadWorkflows`. */
interface LoadWorkflowsOptions {
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
interface WorkflowPlugin {
    name: string;
    description: string;
    workflows: WorkflowDefinition[];
}
/**
 * Minimal elizaOS Skill shape.
 * Used by `toSkill` as the return type when @elizaos/core does not export Skill.
 */
interface ElizaSkill {
    name: string;
    description: string;
    tags?: string[];
    aliases?: string[];
}

/**
 * Parse and serialize `---`-fenced YAML frontmatter blocks.
 *
 * Matches the elizaOS Skill frontmatter convention:
 * a leading `---\n...\n---\n` block containing YAML key-value pairs.
 *
 * @module
 */

/**
 * Parse the `---`-fenced YAML frontmatter block from `source`.
 *
 * Returns `{ frontmatter, body }` where `body` is the remainder of the file
 * after the closing `---`. When no frontmatter block is present, `frontmatter`
 * is an empty object and `body` equals `source`.
 */
declare function parseWorkflowFrontmatter(source: string): {
    frontmatter: WorkflowFrontmatter;
    body: string;
};
/**
 * Return `source` with the leading `---` YAML frontmatter block stripped.
 * When no frontmatter block is present, `source` is returned unchanged.
 */
declare function stripFrontmatter(source: string): string;
/**
 * Serialize `frontmatter` as a `---`-fenced YAML block and concatenate `body`.
 * Produces a complete workflow file string.
 *
 * @example
 * ```ts
 * const file = serializeWorkflowFile({ name: "close-issues", description: "Fix issues" }, tsxSource);
 * // "---\nname: close-issues\n...\n---\n<TSX content>"
 * ```
 */
declare function serializeWorkflowFile(frontmatter: WorkflowFrontmatter, body: string): string;
/**
 * Generate a `---`-fenced YAML frontmatter block string from a plain object.
 * Useful for scaffolding new workflow file headers.
 */
declare function serializeWorkflowFrontmatter(fields: WorkflowFrontmatter): string;

/**
 * `defineWorkflow` and `defineWorkflowPlugin` — elizaOS-style factory functions
 * for authoring Smithers workflows with familiar conventions.
 *
 * @module
 */

/** Input accepted by `defineWorkflow` — camelCase or kebab-case frontmatter fields. */
type DefineWorkflowInput = Omit<WorkflowDefinition, "disableModelInvocation"> & {
    disableModelInvocation?: boolean;
    /** elizaOS kebab-case alias for `disableModelInvocation`. */
    "disable-model-invocation"?: boolean;
};
/**
 * Define a single Smithers workflow using elizaOS-style conventions.
 *
 * Accepts both camelCase (`disableModelInvocation`) and elizaOS kebab-case
 * (`disable-model-invocation`) frontmatter field names, normalizing to camelCase.
 *
 * @example
 * ```ts
 * const myWorkflow = defineWorkflow({
 *   name: "close-issues",
 *   description: "Fix and land every open GitHub issue.",
 *   tags: ["github"],
 *   workflow: smithers(ctx => <Workflow>{...}</Workflow>),
 * });
 * ```
 */
declare function defineWorkflow(definition: DefineWorkflowInput): WorkflowDefinition;
/**
 * Define a workflow plugin — a named, versioned collection of WorkflowDefinitions.
 *
 * Mirrors the elizaOS Plugin shape so callers familiar with elizaOS can compose
 * Smithers workflows into plugins and register them with `registerWorkflows`.
 *
 * @example
 * ```ts
 * const myPlugin = defineWorkflowPlugin({
 *   name: "my-org-workflows",
 *   description: "Shared workflows for my-org.",
 *   workflows: [closeIssues, triage, deploy],
 * });
 * ```
 */
declare function defineWorkflowPlugin(plugin: WorkflowPlugin): WorkflowPlugin;

/**
 * Workflow loaders — discover and load workflow files from the filesystem.
 *
 * `loadWorkflowsFromDir` walks a directory, dynamic-imports each workflow file,
 * reads its `---` YAML frontmatter, and builds `WorkflowDefinition` objects.
 *
 * `loadWorkflows` aggregates across multiple sources with precedence ordering:
 * bundled < managed < project. Later sources override earlier ones on name
 * collision, and a `collision` diagnostic is emitted for each override.
 *
 * @module
 */

/**
 * Load all workflows from a single directory.
 *
 * @param options.dir - Absolute path to the directory to scan.
 * @param options.source - Human-readable source label for diagnostics (e.g. "project", "bundled").
 */
declare function loadWorkflowsFromDir({ dir, source, }: {
    dir: string;
    source?: string;
}): Promise<LoadWorkflowsResult>;
/**
 * Load workflows from multiple sources, deduplicating by name with precedence ordering.
 *
 * Sources are processed lowest-to-highest precedence:
 *   bundledDir < managedDir (~/.smithers/workflows) < <cwd>/.smithers/workflows
 *
 * When two workflows share a name, the higher-precedence (later) source wins and
 * a `collision` diagnostic is emitted.
 */
declare function loadWorkflows(options?: LoadWorkflowsOptions): Promise<LoadWorkflowsResult>;

/**
 * Format a list of WorkflowDefinitions as a human-readable prompt string.
 *
 * Mirrors the pattern elizaOS uses to inject skill lists into system prompts.
 * Workflows with `disableModelInvocation: true` are omitted from the output.
 *
 * @module
 */

interface FormatWorkflowsOptions {
    /** Heading to inject above the list. Defaults to "## Available Workflows". */
    heading?: string;
    /** Whether to include tags in the formatted output. Defaults to `true`. */
    includeTags?: boolean;
    /** Whether to include aliases in the formatted output. Defaults to `true`. */
    includeAliases?: boolean;
}
/**
 * Render a list of WorkflowDefinitions as a Markdown-ish prompt section.
 *
 * Workflows with `disableModelInvocation: true` are excluded so the LLM cannot
 * invoke them (matching elizaOS `formatSkillsForPrompt` behavior).
 */
declare function formatWorkflowsForPrompt(workflows: WorkflowDefinition[], options?: FormatWorkflowsOptions): string;

/**
 * Workflow registration helpers — bridge WorkflowDefinition objects into the
 * Smithers gateway/CLI workflow registry.
 *
 * @module
 */

/**
 * Minimal interface that a Smithers gateway/registry must implement to receive
 * workflow registrations. Duck-typed — does not require importing gateway types.
 */
interface WorkflowRegistry {
    register(name: string, workflow: unknown): void;
}
/**
 * Register all `WorkflowDefinition` objects into a workflow registry.
 *
 * @example
 * ```ts
 * const { gateway } = createSmithers(schemas);
 * registerWorkflows(gateway, workflows);
 * ```
 */
declare function registerWorkflows(registry: WorkflowRegistry, workflows: WorkflowDefinition[]): void;
/**
 * Convert a `WorkflowDefinition` to an elizaOS-compatible `Skill`-shaped object.
 *
 * Maps `name`, `description`, `tags`, and `aliases` through unchanged so the
 * Smithers workflow can be surfaced inside an Eliza agent's skill list.
 */
declare function toSkill(def: WorkflowDefinition): ElizaSkill;
/**
 * Convert a `WorkflowPlugin` to an elizaOS Plugin shape.
 * Each workflow in the plugin becomes an elizaOS Skill via `toSkill`.
 */
declare function pluginToElizaPlugin(plugin: WorkflowPlugin): {
    name: string;
    description: string;
    skills: ElizaSkill[];
};

export { type DefineWorkflowInput, type ElizaSkill, type FormatWorkflowsOptions, type LoadWorkflowsOptions, type LoadWorkflowsResult, type WorkflowDefinition, type WorkflowDiagnostic, type WorkflowDiagnosticType, type WorkflowEntry, type WorkflowFrontmatter, type WorkflowPlugin, type WorkflowRegistry, defineWorkflow, defineWorkflowPlugin, formatWorkflowsForPrompt, loadWorkflows, loadWorkflowsFromDir, parseWorkflowFrontmatter, pluginToElizaPlugin, registerWorkflows, serializeWorkflowFile, serializeWorkflowFrontmatter, stripFrontmatter, toSkill };

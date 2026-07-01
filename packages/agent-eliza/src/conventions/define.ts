/**
 * `defineWorkflow` and `defineWorkflowPlugin` — elizaOS-style factory functions
 * for authoring Smithers workflows with familiar conventions.
 *
 * Mirrors the pattern elizaOS uses for `defineSkill` / plugin objects:
 * a plain object with a name, description, and a collection of capabilities.
 *
 * @module
 */

import type { WorkflowDefinition, WorkflowPlugin } from "./types.js";

/**
 * Define a single Smithers workflow using elizaOS-style conventions.
 *
 * @example
 * ```ts
 * const myWorkflow = defineWorkflow({
 *   name: "close-issues",
 *   description: "Fix and land every open GitHub issue.",
 *   tags: ["github"],
 *   workflow: smithers.workflow(ctx => ctx.agent("Fix the issues")),
 * });
 * ```
 */
export function defineWorkflow(
  definition: Omit<WorkflowDefinition, "name"> & { name: string }
): WorkflowDefinition {
  if (!definition.name) {
    throw new TypeError("defineWorkflow: name is required");
  }
  if (!definition.workflow) {
    throw new TypeError(
      `defineWorkflow: \`workflow\` is required (in "${definition.name}")`
    );
  }
  return { ...definition };
}

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
export function defineWorkflowPlugin(plugin: WorkflowPlugin): WorkflowPlugin {
  if (!plugin.name) {
    throw new TypeError("defineWorkflowPlugin: name is required");
  }
  if (!Array.isArray(plugin.workflows)) {
    throw new TypeError(
      `defineWorkflowPlugin: \`workflows\` must be an array (in "${plugin.name}")`
    );
  }
  return { ...plugin };
}

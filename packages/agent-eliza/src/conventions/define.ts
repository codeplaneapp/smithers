/**
 * `defineWorkflow` and `defineWorkflowPlugin` — elizaOS-style factory functions
 * for authoring Smithers workflows with familiar conventions.
 *
 * @module
 */

import type { WorkflowDefinition, WorkflowPlugin } from "./types.js";

/** Input accepted by `defineWorkflow` — camelCase or kebab-case frontmatter fields. */
export type DefineWorkflowInput = Omit<WorkflowDefinition, "disableModelInvocation"> & {
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
export function defineWorkflow(definition: DefineWorkflowInput): WorkflowDefinition {
  if (!definition.name) {
    throw new TypeError("defineWorkflow: name is required");
  }
  if (!definition.description) {
    throw new TypeError(
      `defineWorkflow: description is required (in "${definition.name}")`
    );
  }
  if (!definition.workflow) {
    throw new TypeError(
      `defineWorkflow: \`workflow\` is required (in "${definition.name}")`
    );
  }

  // Normalize kebab-case to camelCase.
  const disableModelInvocation =
    definition.disableModelInvocation ??
    definition["disable-model-invocation"];

  const { "disable-model-invocation": _dropped, ...rest } = definition;

  return {
    ...rest,
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
  };
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

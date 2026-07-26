/**
 * `defineWorkflow` and `defineWorkflowPlugin` — elizaOS-style factory functions
 * for authoring Smithers workflows with familiar conventions.
 *
 * @module
 */

/** @typedef {import("./types.js").WorkflowDefinition} WorkflowDefinition */
/** @typedef {import("./types.js").WorkflowPlugin} WorkflowPlugin */

/**
 * Input accepted by `defineWorkflow` — camelCase or kebab-case frontmatter fields.
 *
 * @typedef {Omit<WorkflowDefinition, "disableModelInvocation"> & {
 *   disableModelInvocation?: boolean;
 *   "disable-model-invocation"?: boolean;
 * }} DefineWorkflowInput
 */

/**
 * Define a single Smithers workflow using elizaOS-style conventions.
 *
 * Accepts both camelCase (`disableModelInvocation`) and elizaOS kebab-case
 * (`disable-model-invocation`) frontmatter field names, normalizing to camelCase.
 *
 * @param {DefineWorkflowInput} definition
 * @returns {WorkflowDefinition}
 */
export function defineWorkflow(definition) {
  if (!definition.name) {
    throw new TypeError("defineWorkflow: name is required");
  }
  if (!definition.description) {
    throw new TypeError(`defineWorkflow: description is required (in "${definition.name}")`);
  }
  if (!definition.workflow) {
    throw new TypeError(`defineWorkflow: \`workflow\` is required (in "${definition.name}")`);
  }

  // Normalize kebab-case to camelCase.
  const disableModelInvocation = definition.disableModelInvocation ?? definition["disable-model-invocation"];

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
 * @param {WorkflowPlugin} plugin
 * @returns {WorkflowPlugin}
 */
export function defineWorkflowPlugin(plugin) {
  if (!plugin.name) {
    throw new TypeError("defineWorkflowPlugin: name is required");
  }
  if (!Array.isArray(plugin.workflows)) {
    throw new TypeError(`defineWorkflowPlugin: \`workflows\` must be an array (in "${plugin.name}")`);
  }
  return { ...plugin };
}

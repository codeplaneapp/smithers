/**
 * Workflow registration helpers — bridge WorkflowDefinition objects into the
 * Smithers gateway/CLI workflow registry.
 *
 * @module
 */

/** @typedef {import("./types.js").WorkflowDefinition} WorkflowDefinition */
/** @typedef {import("./types.js").WorkflowPlugin} WorkflowPlugin */
/** @typedef {import("./types.js").ElizaSkill} ElizaSkill */

/**
 * Minimal interface that a Smithers gateway/registry must implement to receive
 * workflow registrations. Duck-typed — does not require importing gateway types.
 *
 * @typedef {{ register(name: string, workflow: unknown): void }} WorkflowRegistry
 */

/**
 * Register all `WorkflowDefinition` objects into a workflow registry.
 *
 * @param {WorkflowRegistry} registry
 * @param {WorkflowDefinition[]} workflows
 * @returns {void}
 */
export function registerWorkflows(registry, workflows) {
  for (const def of workflows) {
    registry.register(def.name, def.workflow);
  }
}

/**
 * Convert a `WorkflowDefinition` to an elizaOS-compatible `Skill`-shaped object.
 *
 * @param {WorkflowDefinition} def
 * @returns {ElizaSkill}
 */
export function toSkill(def) {
  return {
    name: def.name,
    description: def.description,
    ...(def.tags !== undefined ? { tags: def.tags } : {}),
    ...(def.aliases !== undefined ? { aliases: def.aliases } : {}),
  };
}

/**
 * Convert a `WorkflowPlugin` to an elizaOS Plugin shape.
 * Each workflow in the plugin becomes an elizaOS Skill via `toSkill`.
 *
 * @param {WorkflowPlugin} plugin
 * @returns {{ name: string; description: string; skills: ElizaSkill[] }}
 */
export function pluginToElizaPlugin(plugin) {
  return {
    name: plugin.name,
    description: plugin.description,
    skills: plugin.workflows.map(toSkill),
  };
}

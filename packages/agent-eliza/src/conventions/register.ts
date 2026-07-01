/**
 * Workflow registration helpers — bridge WorkflowDefinition objects into the
 * Smithers gateway/CLI workflow registry.
 *
 * @module
 */

import type { WorkflowDefinition, WorkflowPlugin, ElizaSkill } from "./types.js";

/**
 * Minimal interface that a Smithers gateway/registry must implement to receive
 * workflow registrations. Duck-typed — does not require importing gateway types.
 */
export interface WorkflowRegistry {
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
export function registerWorkflows(
  registry: WorkflowRegistry,
  workflows: WorkflowDefinition[]
): void {
  for (const def of workflows) {
    registry.register(def.name, def.workflow);
  }
}

/**
 * Convert a `WorkflowDefinition` to an elizaOS-compatible `Skill`-shaped object.
 *
 * Maps `name`, `description`, `tags`, and `aliases` through unchanged so the
 * Smithers workflow can be surfaced inside an Eliza agent's skill list.
 */
export function toSkill(def: WorkflowDefinition): ElizaSkill {
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
 */
export function pluginToElizaPlugin(plugin: WorkflowPlugin): {
  name: string;
  description: string;
  skills: ElizaSkill[];
} {
  return {
    name: plugin.name,
    description: plugin.description,
    skills: plugin.workflows.map(toSkill),
  };
}

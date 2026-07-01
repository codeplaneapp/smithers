/**
 * Workflow registration helpers — bridge WorkflowDefinition objects into the
 * Smithers gateway/CLI workflow registry.
 *
 * `registerWorkflows` accepts a minimal "registry" interface (duck-typed, so
 * this module has no hard dep on `smithers-orchestrator`'s internal packages)
 * and registers each WorkflowDefinition under its canonical name.
 *
 * `toSkill` converts a WorkflowDefinition to the elizaOS Skill/Action shape
 * so Smithers workflows can be surfaced inside an Eliza agent as skills.
 *
 * @module
 */

import type { WorkflowDefinition, WorkflowPlugin } from "./types.js";

/**
 * Minimal interface that a Smithers gateway/registry must implement to receive
 * workflow registrations. Duck-typed — does not require importing gateway types.
 */
export interface WorkflowRegistry {
  /**
   * Register a workflow under `name`.
   * Corresponds to the internal `addWorkflow` / `registerWorkflow` call that
   * the gateway uses when it discovers workflows from a pack directory.
   */
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
 * Convert a WorkflowDefinition to an elizaOS-compatible Skill/Action object.
 *
 * The returned object has `name`, `description`, `similes` (aliases), and a
 * `handler` that throws — the intent is for the action to be wired into an
 * eliza plugin that dispatches to Smithers at runtime.
 *
 * Callers that need a real handler should wrap the returned object and replace
 * `handler` with their Smithers dispatch logic.
 */
export interface ElizaAction {
  name: string;
  description: string;
  similes: string[];
  validate: () => Promise<boolean>;
  handler: (
    runtime: unknown,
    message: unknown,
    state: unknown,
    options: unknown,
    callback: unknown
  ) => Promise<boolean>;
  examples: unknown[][];
}

/**
 * Convert a single `WorkflowDefinition` to an elizaOS Action shape.
 *
 * The handler is a stub that logs a message and resolves `false`.
 * Replace it with your dispatch logic when using this in an eliza plugin.
 */
export function toSkill(def: WorkflowDefinition): ElizaAction {
  return {
    name: def.name.toUpperCase().replace(/-/g, "_"),
    description: def.description || def.name,
    similes: def.aliases ?? [],
    validate: async () => true,
    handler: async (
      _runtime: unknown,
      _message: unknown,
      _state: unknown,
      _options: unknown,
      _callback: unknown
    ) => {
      // Stub handler — replace with Smithers dispatch logic.
      // e.g. await smithersGateway.run(def.name, { ... });
      return false;
    },
    examples: [],
  };
}

/**
 * Convert a `WorkflowPlugin` to an elizaOS Plugin shape.
 * Each workflow in the plugin becomes an elizaOS Action via `toSkill`.
 */
export function pluginToElizaPlugin(plugin: WorkflowPlugin): {
  name: string;
  description: string;
  actions: ElizaAction[];
} {
  return {
    name: plugin.name,
    description: plugin.description,
    actions: plugin.workflows.map(toSkill),
  };
}

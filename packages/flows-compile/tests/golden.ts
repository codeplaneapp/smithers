import type { CompiledWorkflow } from "../src/index.ts";

/**
 * The committed form of a compilation.
 *
 * Everything here is a pure function of the fixture: the plan the compiler
 * produced, and the Smithers-to-plan mapping it annotated the flow with. A
 * change in either shows up as a golden diff.
 */
export const serialize = (compiled: CompiledWorkflow): unknown => ({
  plan: compiled.plan,
  flow: compiled.flow._tag,
  nodes: compiled.nodes,
  diagnostics: compiled.diagnostics,
});

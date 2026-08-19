/**
 * The Graph to Plan compiler.
 *
 * Stage 1.2 of the flows migration
 * (`.smithers/specs/flows-migration.md`). A `GraphSnapshot` from
 * `@smthrs/graph`'s `extractGraph` compiles into a `@smthrs/plan` keyed action
 * graph plus the `@smthrs/flow` declarations its steps dispatch through.
 *
 * - An agent task becomes a harness `AgentStep` action.
 * - A compute task becomes an action whose body runs the `computeFn`.
 * - A static task becomes a sealed constant step.
 * - `dependsOn`, `needs`, and the `deps` they are resolved from become plan
 *   edges; the plan derives conflicts, ordering, and keys from content.
 * - Smithers node ids ride along as flow annotations, so the gateway, the UI,
 *   and the CLI keep addressing nodes by the ids they already show while step
 *   identity is the flows content hash.
 */

export {
  actionFor,
  actions,
  actionTag,
  AgentCall,
  allActions,
  ComputeCall,
  StaticCall,
  type TaskKind,
  type Tier,
} from "./actions.ts";
export {
  makeNodeIndex,
  smithersNodes,
  SmithersNodes,
  smithersOrigin,
  SmithersOrigin,
  type CompiledAnnotations,
  type SmithersNodeIndex,
} from "./annotations.ts";
export { compileGraphSnapshot, tierOf } from "./compileGraphSnapshot.ts";
export { computeImplementation, implementationLayers, staticImplementation } from "./implementations.ts";
export {
  CompileError,
  type CompiledFlow,
  type CompiledNode,
  type CompiledWorkflow,
  type CompileDiagnostic,
  type CompileOptions,
} from "./types.ts";

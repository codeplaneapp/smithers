import type * as Plan from "@flows/plan/Plan";
import type { TaskDescriptor } from "@smthrs/graph/types";
import type { TaskKind, Tier } from "./actions.ts";

/** One Smithers task, after compilation. */
export type CompiledNode = {
  /** Structural address in the plan. Derived from position, never hashed. */
  readonly planNodeId: string;
  /** The Smithers node id the gateway, UI, and CLI address this task by. */
  readonly nodeId: string;
  /** The flows content hash that is this step's real identity. */
  readonly key: string;
  readonly kind: TaskKind;
  readonly tier: Tier;
  /** The dispatch tag of the action declaration this task compiled to. */
  readonly action: string;
  readonly ordinal: number;
  readonly iteration: number;
  readonly label?: string;
  /** Plan node ids this task consumes a value from (`needs`). */
  readonly consumes: readonly string[];
  /** Plan node ids this task is only ordered behind (`dependsOn`, `forkSource`). */
  readonly after: readonly string[];
};

/** Topology a frame declared that the plan could not represent. */
export type CompileDiagnostic = {
  readonly code: "unknown_dependency";
  readonly nodeId: string;
  readonly message: string;
};

export type CompileOptions = {
  /** Plan id. Defaults to the snapshot's `runId`. */
  readonly planId?: string;
  /** Flow tag. Defaults to `smithers/workflow`. */
  readonly flowName?: string;
};

/**
 * The flow declaration a compilation emits.
 *
 * Structurally typed rather than `Flow.Flow<...>`: the payload and body of a
 * compiled flow are assembled at runtime from a snapshot, so there is no static
 * tag or schema to name.
 */
export type CompiledFlow = {
  readonly _tag: string;
  readonly annotations: unknown;
  readonly body: (payload: never) => unknown;
};

/** What `compileGraphSnapshot` produces. */
export type CompiledWorkflow = {
  /** The keyed action graph. */
  readonly plan: Plan.Plan;
  /** The flow declaration whose body is that graph, annotated with the node index. */
  readonly flow: CompiledFlow;
  readonly nodes: readonly CompiledNode[];
  /** `computeFn` bodies, keyed by Smithers node id, for the compute action layer. */
  readonly computeFns: ReadonlyMap<string, () => unknown | Promise<unknown>>;
  /** The descriptor each compiled node came from, keyed by plan node id. */
  readonly tasks: ReadonlyMap<string, TaskDescriptor>;
  readonly diagnostics: readonly CompileDiagnostic[];
};

/** A graph the compiler refuses. */
export class CompileError extends Error {
  override readonly name = "CompileError";
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

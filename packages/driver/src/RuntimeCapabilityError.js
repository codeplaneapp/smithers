import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

// @smithers-type-exports-begin
/** @typedef {"filesystem" | "subprocess" | "worktree" | "sandbox"} RuntimeCapability */
/** @typedef {{ runtime: string; capability: RuntimeCapability | string; operation: string }} RuntimeCapabilityErrorDetails */
// @smithers-type-exports-end

/**
 * Stable, registered `SmithersError` code every `RuntimeCapabilityError`
 * carries. Exported so callers can match on it without importing the class
 * itself (e.g. `error.code === RUNTIME_CAPABILITY_UNAVAILABLE`).
 */
export const RUNTIME_CAPABILITY_UNAVAILABLE = "RUNTIME_CAPABILITY_UNAVAILABLE";

/**
 * Thrown by a {@link import("./RuntimeAdapter.ts").RuntimeAdapter} capability
 * namespace (`filesystem`/`subprocess`/`worktree`/`sandbox`) when the current
 * runtime does not implement the requested operation.
 *
 * Every capability namespace on a `RuntimeAdapter` is always present and
 * callable — an adapter never leaves a capability `undefined`. An environment
 * that cannot support an operation (e.g. a browser has no real filesystem)
 * fails CLOSED by throwing this typed error instead of silently no-op'ing or
 * reaching for a Node/Bun global that does not exist there.
 */
export class RuntimeCapabilityError extends SmithersError {
  /** @type {string} */
  runtime;
  /** @type {string} */
  capability;
  /** @type {string} */
  operation;
  /**
   * @param {string} runtime Name of the active runtime (e.g. "browser", "node").
   * @param {string} capability Capability namespace (e.g. "filesystem", "subprocess", "worktree", "sandbox").
   * @param {string} operation Method name that was called (e.g. "readFile", "spawn", "resolve", "run").
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(runtime, capability, operation, opts) {
    super(
      RUNTIME_CAPABILITY_UNAVAILABLE,
      `The "${runtime}" runtime does not support ${capability}.${operation}(). ` +
        `This capability is not available in this environment; configure a ` +
        `RuntimeAdapter that implements it, or avoid calling it here.`,
      { runtime, capability, operation },
      opts?.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "RuntimeCapabilityError";
    this.runtime = runtime;
    this.capability = capability;
    this.operation = operation;
  }
}

import type { RunAuthContext } from "./RunAuthContext.ts";
import type { RunStartedBy } from "./RunStartedBy.ts";
import type { OutputSnapshot } from "./OutputSnapshot.ts";
import type { SmithersErrorReport } from "./SmithersErrorReport.ts";
import type { SignalRowInput } from "./SignalRows.ts";
import type { SmithersEvent } from "@smthrs/observability/SmithersEvent";
import type { Layer } from "effect";

export type EffectPlatformRuntime = "bun" | "node" | "worker";

export type HotReloadOptions = {
  /** Root directory to watch for changes (default: auto-detect from workflow entry) */
  rootDir?: string;
  /** Directory for generation overlays (default: rootDir/.smithers/hmr) */
  outDir?: string;
  /** Max overlay generations to keep (default: 3) */
  maxGenerations?: number;
  /** Whether to cancel tasks that become unmounted after hot reload (default: false) */
  cancelUnmounted?: boolean;
  /** Debounce interval in ms for file change events (default: 100) */
  debounceMs?: number;
};

export type RunOptions = {
  runId?: string;
  parentRunId?: string | null;
  input: Record<string, unknown>;
  maxConcurrency?: number;
  /** Internal/runtime proof that maxConcurrency was explicitly persisted for this run. */
  maxConcurrencyPinned?: boolean;
  requireRerenderOnOutputChange?: boolean;
  onProgress?: (e: SmithersEvent) => void;
  /** Called once for each node or run failure occurrence. */
  onError?: (report: SmithersErrorReport) => void;
  signal?: AbortSignal;
  /**
   * Separate from {@link signal}: aborting this asks the driver to stop
   * scheduling new tasks and park the run `paused` once in-flight tasks settle,
   * WITHOUT aborting those tasks. Used by graceful pause.
   */
  pauseSignal?: AbortSignal;
  resume?: boolean;
  force?: boolean;
  /**
   * Resume this run after its workflow source changed, re-blessing the stored
   * durability metadata (workflow hashes) in place instead of forking to a new
   * run id. Skips ONLY the two workflow-hash mismatches; workflow-path and
   * VCS-root mismatches still reject. Replay determinism becomes the caller's
   * responsibility. Only meaningful together with {@link resume}.
   */
  acceptWorkflowChange?: boolean;
  workflowPath?: string;
  rootDir?: string;
  /**
   * Keep the `<Worktree>` directories this run created instead of reaping them
   * when it finishes (default false: a successful run removes its own worktrees,
   * except any holding uncommitted or unpushed work, which are always kept).
   * Failed and cancelled runs never auto-reap. `SMITHERS_KEEP_WORKTREES=1` is
   * the process-wide equivalent.
   */
  keepWorktrees?: boolean;
  logDir?: string | null;
  allowNetwork?: boolean;
  maxOutputBytes?: number;
  /** Per-checkpoint UTF-8 JSON byte limit; defaults to and cannot exceed the 16 MiB system ceiling. */
  maxAgentCheckpointBytes?: number;
  toolTimeoutMs?: number;
  hot?: boolean | HotReloadOptions;
  annotations?: Record<string, string | number | boolean>;
  auth?: RunAuthContext | null;
  /** Self-reported launch provenance, distinct from authenticated identity. */
  startedBy?: RunStartedBy;
  config?: Record<string, unknown>;
  /**
   * Effect platform runtime label for engines that support a swappable platform
   * layer. "bun" uses the engine's default Bun layer; "node" and "worker"
   * require effectPlatformLayer from the embedding runtime.
   */
  effectPlatformRuntime?: EffectPlatformRuntime;
  /**
   * Custom @effect/platform layer, for example NodeContext.layer supplied by a
   * Node serverless entrypoint that owns @effect/platform-node.
   */
  effectPlatformLayer?: Layer.Layer<any, never, never>;
  cliAgentToolsDefault?: "all" | "explicit-only";
  initialOutputs?: OutputSnapshot;
  /**
   * Fallback signal rows used when no `runtimeAdapter.signals` capability is
   * configured (e.g. tests, the browser runtime). Ignored once a live
   * adapter is present — `runtimeAdapter.signals.load` is re-read every
   * frame and takes priority.
   */
  signals?: SignalRowInput[];
  initialIteration?: number;
  initialIterations?: Record<string, number> | ReadonlyMap<string, number>;
  resumeClaim?: {
    claimOwnerId: string;
    claimHeartbeatAtMs: number;
    restoreRuntimeOwnerId?: string | null;
    restoreHeartbeatAtMs?: number | null;
  };
};

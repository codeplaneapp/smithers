import type { OutputSnapshot } from "./OutputSnapshot.ts";
import type { RunAuthContext } from "./RunAuthContext.ts";
import type { SmithersRuntimeConfig } from "./SmithersRuntimeConfig.ts";
import type { SignalRowInput } from "./SignalRows.ts";

export type SmithersCtxOptions = {
  runId: string;
  iteration: number;
  iterations?: Record<string, number>;
  input: unknown;
  auth?: RunAuthContext | null;
  outputs: OutputSnapshot;
  /** Durable `_smithers_signals` rows for this run, freshly loaded for the current frame. */
  signals?: SignalRowInput[];
  taskStates?: ReadonlyMap<string, unknown> | Record<string, unknown>;
  taskIterations?: ReadonlyMap<string, number> | Record<string, number>;
  zodToKeyName?: Map<any, string>;
  runtimeConfig?: SmithersRuntimeConfig;
};

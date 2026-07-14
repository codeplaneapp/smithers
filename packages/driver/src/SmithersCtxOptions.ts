import type { OutputSnapshot } from "./OutputSnapshot.ts";
import type { RunAuthContext } from "./RunAuthContext.ts";
import type { SmithersRuntimeConfig } from "./SmithersRuntimeConfig.ts";

export type SmithersCtxOptions = {
  runId: string;
  iteration: number;
  iterations?: Record<string, number>;
  input: unknown;
  auth?: RunAuthContext | null;
  outputs: OutputSnapshot;
  taskStates?: ReadonlyMap<string, unknown> | Record<string, unknown>;
  zodToKeyName?: Map<any, string>;
  runtimeConfig?: SmithersRuntimeConfig;
};

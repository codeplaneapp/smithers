import type { OutputSnapshot } from "@smthrs/driver/OutputSnapshot";

export type SerializedCtx = {
  runId: string;
  iteration: number;
  iterations: Record<string, number>;
  input: unknown;
  outputs: OutputSnapshot;
};

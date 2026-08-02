import type { SmithersError } from "@smthrs/errors/SmithersError";

export type SmithersErrorReport = {
  readonly error: SmithersError;
  readonly rawError: unknown;
  readonly runId: string;
} & (
  | {
      readonly phase: "run";
      readonly nodeId?: undefined;
      readonly iteration?: undefined;
      readonly attempt?: undefined;
    }
  | {
      readonly phase: "node";
      readonly nodeId: string;
      readonly iteration: number;
      readonly attempt: number;
    }
);

export type OutputRow<Payload = unknown> = {
  payload: Payload;
  nodeId: string;
  iteration: number;
  seq: number;
};
export type OutputRowsOptions = { nodeId?: string; scope?: string };
export type OutputRowsReader<Schema = unknown> = {
  <K extends keyof Schema & string>(output: K, options?: OutputRowsOptions): Array<OutputRow<InferOutputEntry<Schema[K]>>>;
  <T extends z.ZodTypeAny>(output: T, options?: OutputRowsOptions): Array<OutputRow<z.infer<T>>>;
  <T extends { $inferSelect: unknown }>(output: T, options?: OutputRowsOptions): Array<OutputRow<InferRow<T>>>;
  (output: unknown, options?: OutputRowsOptions): Array<OutputRow<unknown>>;
};
import type { z } from "zod";
import type { InferRow, InferOutputEntry } from "./OutputAccessor.ts";

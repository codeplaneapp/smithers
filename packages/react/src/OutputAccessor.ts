import type { z } from "zod";

export type InferRow<TTable> = TTable extends { $inferSelect: infer R } ? R : never;

export type InferOutputEntry<T> = T extends z.ZodTypeAny
  ? z.infer<T>
  : T extends { $inferSelect: unknown }
    ? InferRow<T>
    : unknown;

type FallbackTableName<Schema> = [keyof Schema & string] extends [never]
  ? string
  : never;

export type OutputAccessor<Schema> = {
  (table: FallbackTableName<Schema>): Array<unknown>;
  <K extends keyof Schema & string>(table: K): Array<InferOutputEntry<Schema[K]>>;
} & {
  [K in keyof Schema & string]: Array<InferOutputEntry<Schema[K]>>;
};

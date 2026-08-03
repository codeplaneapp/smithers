import type { z } from "zod";

export type InferRow<TTable> = TTable extends { $inferSelect: infer R } ? R : never;

export type InferOutputEntry<T> = T extends z.ZodTypeAny
  ? z.infer<T>
  : T extends { $inferSelect: unknown }
    ? InferRow<T>
    : never;

type FallbackTableName<Schema> = [keyof Schema & string] extends [never] ? string : never;

export type OutputAccessor<Schema, TRow = unknown> = {
  (table: FallbackTableName<Schema>): Array<TRow>;
  <K extends keyof Schema & string>(table: K): Array<InferOutputEntry<Schema[K]>>;
  // The output ref (`outputs.myTable`) is the idiomatic argument everywhere
  // else in the API, including `output={outputs.myTable}`, so the callable
  // form accepts it too (#1486).
  <K extends keyof Schema & string>(table: Schema[K]): Array<InferOutputEntry<Schema[K]>>;
} & {
  [K in keyof Schema & string]: Array<InferOutputEntry<Schema[K]>>;
};

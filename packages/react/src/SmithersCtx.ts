import type { OutputAccessor, InferOutputEntry } from "./OutputAccessor";
import type { OutputKey } from "./OutputKey";
import type { RunAuthContext } from "./RunAuthContext";
import type { SmithersRuntimeConfig } from "./context/index";
import type { z } from "zod";

type SchemaKeyForValue<Schema, V> = {
  [K in keyof Schema & string]: Schema[K] extends V ? K : never;
}[keyof Schema & string];

type FallbackTableName<Schema> = [keyof Schema & string] extends [never]
  ? string
  : never;

export interface SmithersCtx<Schema> {
  runId: string;
  iteration: number;
  iterations?: Record<string, number>;
  input: Schema extends { input: infer T }
    ? T extends z.ZodTypeAny
      ? z.infer<T>
      : T
    : unknown;
  auth: RunAuthContext | null;
  __smithersRuntime?: SmithersRuntimeConfig | null;
  outputs: OutputAccessor<Schema>;

  output(table: FallbackTableName<Schema>, key: OutputKey): unknown;
  output<V extends z.ZodTypeAny>(
    table: V,
    key: OutputKey,
  ): SchemaKeyForValue<Schema, V> extends never
    ? InferOutputEntry<V>
    : InferOutputEntry<V>;
  output<K extends keyof Schema & string>(
    table: K,
    key: OutputKey,
  ): InferOutputEntry<Schema[K]>;

  outputMaybe(
    table: FallbackTableName<Schema>,
    key: OutputKey,
  ): unknown | undefined;
  outputMaybe<V extends z.ZodTypeAny>(
    table: V,
    key: OutputKey,
  ): SchemaKeyForValue<Schema, V> extends never
    ? InferOutputEntry<V> | undefined
    : InferOutputEntry<V> | undefined;
  outputMaybe<K extends keyof Schema & string>(
    table: K,
    key: OutputKey,
  ): InferOutputEntry<Schema[K]> | undefined;

  latest<V extends z.ZodTypeAny>(
    table: V,
    nodeId: string,
  ): SchemaKeyForValue<Schema, V> extends never
    ? InferOutputEntry<V> | undefined
    : InferOutputEntry<V> | undefined;
  latest<K extends keyof Schema & string>(
    table: K,
    nodeId: string,
  ): InferOutputEntry<Schema[K]> | undefined;
  latest(table: FallbackTableName<Schema>, nodeId: string): unknown | undefined;

  latestArray(value: unknown, schema: z.ZodType): unknown[];
  iterationCount(table: unknown, nodeId: string): number;
}

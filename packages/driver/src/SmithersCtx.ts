import type { z } from "zod";
import type { OutputAccessor } from "./OutputAccessor.ts";
import type { OutputKey } from "./OutputKey.ts";
import type { OutputSnapshot } from "./OutputSnapshot.ts";
import type { RunAuthContext } from "./RunAuthContext.ts";
import type { SmithersRuntimeConfig } from "./SmithersRuntimeConfig.ts";
/**
 * Reverse-lookup: given Schema and a value type V, find the key K where Schema[K] extends V.
 * Used to narrow return types when passing Zod schema objects directly.
 */
type SchemaKeyForValue<Schema, V> = {
    [K in keyof Schema & string]: Schema[K] extends V ? K : never;
}[keyof Schema & string];
type InferRow<TTable> = TTable extends {
    $inferSelect: infer R;
} ? R : never;
type InferOutputEntry<T> = T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: any;
} ? InferRow<T> : never;
type FallbackTableName<Schema> = [keyof Schema & string] extends [never] ? string : never;
type SafeParser = {
    safeParse(value: unknown): {
        success: true;
        data: unknown;
    } | {
        success: false;
        error?: unknown;
    };
};
export type SmithersCtxOptions = {
    runId: string;
    iteration: number;
    iterations?: Record<string, number>;
    input: unknown;
    auth?: RunAuthContext | null;
    outputs: OutputSnapshot;
    zodToKeyName?: Map<any, string>;
    runtimeConfig?: SmithersRuntimeConfig;
};
export declare class SmithersCtx<Schema = unknown> {
    readonly runId: string;
    readonly iteration: number;
    readonly iterations?: Record<string, number>;
    readonly input: Schema extends {
        input: infer T;
    } ? T extends z.ZodTypeAny ? z.infer<T> : T : any;
    readonly auth: RunAuthContext | null;
    readonly __smithersRuntime?: SmithersRuntimeConfig | null;
    readonly outputs: OutputAccessor<Schema>;
    private readonly _outputs;
    private readonly _zodToKeyName?;
    private readonly _currentScopes;
    constructor(opts: SmithersCtxOptions);
    output(table: FallbackTableName<Schema>, key: OutputKey): any;
    output<V extends z.ZodTypeAny>(table: V, key: OutputKey): SchemaKeyForValue<Schema, V> extends never ? InferOutputEntry<V> : InferOutputEntry<V>;
    output<K extends keyof Schema & string>(table: K, key: OutputKey): InferOutputEntry<Schema[K]>;
    outputMaybe(table: FallbackTableName<Schema>, key: OutputKey): any | undefined;
    outputMaybe<V extends z.ZodTypeAny>(table: V, key: OutputKey): SchemaKeyForValue<Schema, V> extends never ? InferOutputEntry<V> | undefined : InferOutputEntry<V> | undefined;
    outputMaybe<K extends keyof Schema & string>(table: K, key: OutputKey): InferOutputEntry<Schema[K]> | undefined;
    latest<V extends z.ZodTypeAny>(table: V, nodeId: string): SchemaKeyForValue<Schema, V> extends never ? InferOutputEntry<V> | undefined : InferOutputEntry<V> | undefined;
    latest<K extends keyof Schema & string>(table: K, nodeId: string): InferOutputEntry<Schema[K]> | undefined;
    latest(table: FallbackTableName<Schema>, nodeId: string): any | undefined;
    latestArray(value: unknown, schema: SafeParser): unknown[];
    iterationCount(table: any, nodeId: string): number;
    private resolveTableName;
    private resolveRow;
}
export {};

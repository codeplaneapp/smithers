import type { AnyColumn, Table } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersError } from "@smithers/errors/SmithersError";
export type OutputKey = {
    runId: string;
    nodeId: string;
    iteration?: number;
};
export declare function buildOutputRow(table: Table, runId: string, nodeId: string, iteration: number, payload: unknown): {
    runId: string;
    nodeId: string;
    iteration: number;
    payload: any;
} | {
    runId: string;
    nodeId: string;
    iteration: number;
    payload?: undefined;
};
export declare function stripAutoColumns(payload: unknown): unknown;
export declare function getKeyColumns(table: Table): {
    runId: AnyColumn;
    nodeId: AnyColumn;
    iteration?: AnyColumn;
};
export declare function buildKeyWhere(table: Table, key: OutputKey): import("drizzle-orm").SQL<unknown> | undefined;
export declare function selectOutputRowEffect<T>(db: any, table: Table, key: OutputKey): Effect.Effect<T | undefined, SmithersError>;
export declare function selectOutputRow<T>(db: any, table: Table, key: OutputKey): Promise<T | undefined>;
export declare function upsertOutputRowEffect(db: any, table: Table, key: OutputKey, payload: Record<string, unknown>): Effect.Effect<void, SmithersError>;
export declare function upsertOutputRow(db: any, table: Table, key: OutputKey, payload: Record<string, unknown>): Promise<void>;
export declare function validateOutput(table: Table, payload: unknown): {
    ok: boolean;
    data?: any;
    error?: z.ZodError;
};
export declare function validateExistingOutput(table: Table, payload: unknown): {
    ok: boolean;
    data?: any;
    error?: z.ZodError;
};
/**
 * Creates a Zod schema for agent output by removing runId, nodeId, iteration
 * (which are auto-populated by smithers)
 */
export declare function getAgentOutputSchema(table: Table): z.ZodObject<any>;
/**
 * Describes a schema as a JSON Schema string for agent prompts.
 * Prefers the original Zod schema's `.toJSONSchema()` (Zod 4) which preserves
 * field descriptions. Falls back to deriving from the Drizzle table.
 */
export declare function describeSchemaShape(tableOrSchema: Table | z.ZodObject<any>, zodSchema?: z.ZodObject<any>): string;

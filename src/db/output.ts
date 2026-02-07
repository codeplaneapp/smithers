import { and, eq } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import type { AnyColumn, Table } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

export type OutputKey = { runId: string; nodeId: string; iteration?: number };

export function getKeyColumns(table: Table): {
  runId: AnyColumn;
  nodeId: AnyColumn;
  iteration?: AnyColumn;
} {
  const cols = getTableColumns(table as any) as Record<string, AnyColumn>;
  const runId = cols.runId;
  const nodeId = cols.nodeId;
  const iteration = cols.iteration;
  if (!runId || !nodeId) {
    throw new Error(
      `Output table ${table["_"]?.name ?? ""} must include runId and nodeId columns.`,
    );
  }
  return { runId, nodeId, iteration };
}

export function buildKeyWhere(table: Table, key: OutputKey) {
  const cols = getKeyColumns(table);
  const clauses = [eq(cols.runId, key.runId), eq(cols.nodeId, key.nodeId)];
  if (cols.iteration) {
    clauses.push(eq(cols.iteration, key.iteration ?? 0));
  }
  return and(...clauses);
}

export async function selectOutputRow<T>(db: any, table: Table, key: OutputKey): Promise<T | undefined> {
  const where = buildKeyWhere(table, key);
  const rows = await db.select().from(table as any).where(where).limit(1);
  return rows[0] as T | undefined;
}

export async function upsertOutputRow(db: any, table: Table, key: OutputKey, payload: Record<string, unknown>) {
  const cols = getKeyColumns(table);
  const values: Record<string, unknown> = { ...payload };
  values.runId = key.runId;
  values.nodeId = key.nodeId;
  if (cols.iteration) {
    values.iteration = key.iteration ?? 0;
  }

  const target = cols.iteration
    ? [cols.runId, cols.nodeId, cols.iteration]
    : [cols.runId, cols.nodeId];

  await db
    .insert(table as any)
    .values(values)
    .onConflictDoUpdate({
      target,
      set: values,
    });
}

export function validateOutput(table: Table, payload: unknown): {
  ok: boolean;
  data?: any;
  error?: z.ZodError;
} {
  const schema = createInsertSchema(table as any);
  const result = schema.safeParse(payload);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: result.error };
}

export function validateExistingOutput(table: Table, payload: unknown): {
  ok: boolean;
  data?: any;
  error?: z.ZodError;
} {
  const schema = createSelectSchema(table as any);
  const result = schema.safeParse(payload);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: result.error };
}

/**
 * Creates a Zod schema for agent output by removing runId, nodeId, iteration
 * (which are auto-populated by smithers)
 */
export function getAgentOutputSchema(table: Table): z.ZodObject<any> {
  const baseSchema = createInsertSchema(table as any) as z.ZodObject<any>;
  // Remove the key columns that smithers populates automatically
  const shape = baseSchema.shape;
  const { runId, nodeId, iteration, ...rest } = shape;
  return z.object(rest);
}

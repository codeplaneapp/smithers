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

export async function selectOutputRow<T>(
  db: any,
  table: Table,
  key: OutputKey,
): Promise<T | undefined> {
  const where = buildKeyWhere(table, key);
  const rows = await db
    .select()
    .from(table as any)
    .where(where)
    .limit(1);
  return rows[0] as T | undefined;
}

export async function upsertOutputRow(
  db: any,
  table: Table,
  key: OutputKey,
  payload: Record<string, unknown>,
) {
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

export function validateOutput(
  table: Table,
  payload: unknown,
): {
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

export function validateExistingOutput(
  table: Table,
  payload: unknown,
): {
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

/**
 * Describes a Zod schema shape as a human-readable JSON example string.
 * Used for schema-validation retry prompts so the agent knows exactly
 * what fields and types are expected.
 */
export function describeSchemaShape(table: Table): string {
  const agentSchema = getAgentOutputSchema(table);
  const shape = agentSchema.shape as Record<string, z.ZodType>;
  const fields: Record<string, string> = {};
  for (const [key, zodType] of Object.entries(shape)) {
    fields[key] = describeZodType(zodType);
  }
  return JSON.stringify(fields, null, 2);
}

function describeZodType(schema: z.ZodType): string {
  // Unwrap optionals/defaults/nullables to get the inner type description
  if ((schema as any)._zod?.def) {
    const def = (schema as any)._zod.def;
    const typeName = def.type;
    if (
      typeName === "optional" ||
      typeName === "default" ||
      typeName === "nullable"
    ) {
      const inner = def.innerType ? describeZodType(def.innerType) : "unknown";
      if (typeName === "optional") return `${inner} (optional)`;
      if (typeName === "nullable") return `${inner} | null`;
      return inner;
    }
    if (typeName === "string") return "string";
    if (typeName === "number" || typeName === "int" || typeName === "float")
      return "number";
    if (typeName === "boolean") return "boolean";
    if (typeName === "array") {
      const itemType = def.element ? describeZodType(def.element) : "unknown";
      return `${itemType}[]`;
    }
    if (typeName === "object") return "object";
    if (typeName === "enum") return `enum(${(def.values ?? []).join(" | ")})`;
    if (typeName === "literal") return `literal(${JSON.stringify(def.value)})`;
    if (typeName === "union") {
      const options = (def.options ?? []).map((o: z.ZodType) =>
        describeZodType(o),
      );
      return options.join(" | ");
    }
  }
  // Zod v3 fallback
  const desc = (schema as any)._def?.typeName;
  if (desc === "ZodString") return "string";
  if (desc === "ZodNumber") return "number";
  if (desc === "ZodBoolean") return "boolean";
  if (desc === "ZodArray") return "array";
  if (desc === "ZodOptional") {
    const inner = (schema as any)._def?.innerType;
    return inner
      ? `${describeZodType(inner)} (optional)`
      : "unknown (optional)";
  }
  if (desc === "ZodDefault") {
    const inner = (schema as any)._def?.innerType;
    return inner ? describeZodType(inner) : "unknown";
  }
  if (desc === "ZodNullable") {
    const inner = (schema as any)._def?.innerType;
    return inner ? `${describeZodType(inner)} | null` : "unknown | null";
  }
  return "unknown";
}

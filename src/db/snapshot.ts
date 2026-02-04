import { eq } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import type { OutputSnapshot } from "../context";

export async function loadInput(db: any, inputTable: any, runId: string) {
  const cols = getTableColumns(inputTable as any) as Record<string, any>;
  const runIdCol = cols.runId;
  if (!runIdCol) {
    throw new Error("schema.input must include runId column");
  }
  const rows = await db.select().from(inputTable).where(eq(runIdCol, runId)).limit(1);
  return rows[0];
}

export async function loadOutputs(db: any, schema: Record<string, any>, runId: string): Promise<OutputSnapshot> {
  const out: OutputSnapshot = {};
  for (const [key, table] of Object.entries(schema)) {
    if (!table || typeof table !== "object") continue;
    if (key === "input") continue;
    const cols = getTableColumns(table as any) as Record<string, any>;
    const runIdCol = cols.runId;
    if (!runIdCol) continue;
    const rows = await db.select().from(table as any).where(eq(runIdCol, runId));
    out[getTableName(table as any)] = rows;
    out[key] = rows;
  }
  return out;
}

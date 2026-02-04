import type { SmithersCtx, OutputKey, InferRow } from "./types";
import { getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";

export type OutputSnapshot = {
  [tableName: string]: Array<any>;
};

export function buildContext<Schema>(opts: {
  runId: string;
  iteration: number;
  input: any;
  outputs: OutputSnapshot;
}): SmithersCtx<Schema> {
  const { runId, iteration, input, outputs } = opts;

  const outputsFn: any = (table: any) => {
    const name = getTableName(table);
    return outputs[name] ?? [];
  };

  for (const [name, rows] of Object.entries(outputs)) {
    outputsFn[name] = rows;
  }

  function resolveRow<T>(table: any, key: OutputKey): T | undefined {
    const name = getTableName(table);
    const rows = outputs[name] ?? [];
    const cols = getTableColumns(table as any) as Record<string, any>;
    const hasIteration = Boolean(cols.iteration);
    return rows.find((row) => {
      if (row.nodeId !== key.nodeId) return false;
      if (!hasIteration) return true;
      return (row.iteration ?? 0) === (key.iteration ?? 0);
    });
  }

  return {
    runId,
    iteration,
    input,
    outputs: outputsFn,
    output<T extends keyof Schema>(table: Schema[T], key: OutputKey): InferRow<Schema[T]> {
      const row = resolveRow<InferRow<Schema[T]>>(table as any, key);
      if (!row) {
        throw new Error(`Missing output for nodeId=${key.nodeId} iteration=${key.iteration ?? 0}`);
      }
      return row;
    },
    outputMaybe<T extends keyof Schema>(table: Schema[T], key: OutputKey): InferRow<Schema[T]> | undefined {
      return resolveRow<InferRow<Schema[T]>>(table as any, key);
    },
  };
}

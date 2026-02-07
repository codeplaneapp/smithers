import type { SmithersWorkflow, SmithersWorkflowOptions, RunOptions, RunResult, GraphSnapshot } from "./types";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type React from "react";
import { runWorkflow as runWorkflowEngine, renderFrame as renderFrameEngine } from "./engine";

export * from "./types";
export * from "./components";
export * from "./agents/cli";

export function smithers<Schema extends Record<string, unknown>>(
  db: BunSQLiteDatabase<Schema>,
  build: (ctx: any) => React.ReactElement,
  opts?: SmithersWorkflowOptions,
): SmithersWorkflow<Schema> {
  return { db, build, opts: opts ?? {} } as SmithersWorkflow<Schema>;
}

export async function runWorkflow<Schema>(
  workflow: SmithersWorkflow<Schema>,
  opts: RunOptions,
): Promise<RunResult> {
  return runWorkflowEngine(workflow, opts);
}

export async function renderFrame<Schema>(
  workflow: SmithersWorkflow<Schema>,
  ctx: any,
): Promise<GraphSnapshot> {
  const snap = await renderFrameEngine(workflow, ctx);
  return { runId: snap.runId, frameNo: snap.frameNo, xml: snap.xml, tasks: snap.tasks };
}

import { AsyncLocalStorage } from "node:async_hooks";
import type { SmithersDb } from "../db/adapter";

export type ToolContext = {
  db: SmithersDb;
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  rootDir: string;
  allowNetwork: boolean;
  maxOutputBytes: number;
  timeoutMs: number;
  seq: number;
};

const storage = new AsyncLocalStorage<ToolContext>();

export function runWithToolContext<T>(
  ctx: ToolContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

export function getToolContext(): ToolContext | undefined {
  return storage.getStore();
}

export function nextToolSeq(ctx: ToolContext): number {
  ctx.seq += 1;
  return ctx.seq;
}

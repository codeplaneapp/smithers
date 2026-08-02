import type { SmithersDb } from "@smthrs/db/adapter";

export type RunTreeCommandInput = {
  adapter: SmithersDb;
  runId: string;
  frameNo?: number;
  depth?: number;
  node?: string;
  color?: boolean;
  json?: boolean;
  abortSignal?: AbortSignal;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

/** Compact, patch-free run footprint returned by the Monitor HTTP API. */
export type RunFootprint = {
  runId: string;
  filesChanged: number;
  totalFiles: number;
  totalDirectories: number;
  added: number;
  removed: number;
  directories: Array<{ path: string; files: number; added: number; removed: number }>;
  files: Array<{ path: string; added: number; removed: number; nodesTouched: number; owner?: { nodeId: string; iteration: number } }>;
  hottestDirectory: { path: string; files: number; added: number; removed: number } | null;
  truncated: boolean;
  skippedNodes: number;
};

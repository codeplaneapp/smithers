import { asNumber, asString, isRecord, pick } from "./monitorModel.ts";

export type FootprintOwner = { nodeId: string; iteration: number };
export type FootprintFile = { path: string; added: number; removed: number; nodesTouched: number; owner: FootprintOwner | null };
export type FootprintDirectory = { path: string; files: number; added: number; removed: number };
export type Footprint = { totalFiles: number; totalDirectories: number; added: number; removed: number; hottestDirectory: FootprintDirectory | null; directories: FootprintDirectory[]; files: FootprintFile[]; truncated: boolean; skippedNodes: number };

function directoryOf(value: unknown): FootprintDirectory | null {
  if (!isRecord(value)) return null;
  const path = asString(value.path); const files = asNumber(value.files);
  if (!path || files === undefined) return null;
  return { path, files, added: asNumber(value.added) ?? 0, removed: asNumber(value.removed) ?? 0 };
}
function fileOf(value: unknown): FootprintFile | null {
  if (!isRecord(value)) return null;
  const path = asString(value.path); if (!path) return null;
  const rawOwner = isRecord(value.owner) ? value.owner : null;
  const ownerId = rawOwner ? asString(pick(rawOwner, "nodeId", "node_id")) : undefined;
  const iteration = rawOwner ? asNumber(rawOwner.iteration) : undefined;
  return { path, added: asNumber(value.added) ?? 0, removed: asNumber(value.removed) ?? 0, nodesTouched: asNumber(pick(value, "nodesTouched", "nodes_touched")) ?? 0, owner: ownerId && iteration !== undefined && Number.isInteger(iteration) ? { nodeId: ownerId, iteration } : null };
}

export function footprintOf(body: unknown): Footprint | null {
  const root = isRecord(body) && body.ok === true && isRecord(body.data) ? body.data : isRecord(body) ? body : null;
  if (!root) return null;
  const directories = Array.isArray(root.directories) ? root.directories.map(directoryOf).filter((value): value is FootprintDirectory => value !== null) : null;
  const files = Array.isArray(root.files) ? root.files.map(fileOf).filter((value): value is FootprintFile => value !== null) : null;
  const totalFiles = asNumber(pick(root, "filesChanged", "files_changed")) ?? asNumber(pick(root, "totalFiles", "total_files"));
  if (!directories || !files || totalFiles === undefined) return null;
  return {
    totalFiles,
    totalDirectories: asNumber(pick(root, "totalDirectories", "total_directories")) ?? directories.length,
    // Older gateways omit the run-level totals; the visible files still carry
    // real counts, so the rollup sums them rather than claiming "+0 −0".
    added: asNumber(root.added) ?? files.reduce((sum, file) => sum + file.added, 0),
    removed: asNumber(root.removed) ?? files.reduce((sum, file) => sum + file.removed, 0),
    hottestDirectory: directoryOf(pick(root, "hottestDirectory", "hottest_directory")),
    directories,
    files,
    truncated: root.truncated === true,
    skippedNodes: asNumber(pick(root, "skippedNodes", "skipped_nodes")) ?? 0,
  };
}

const churn = (value: { added: number; removed: number }) => value.added + value.removed;
const compareByChurn = <T extends { path: string; added: number; removed: number }>(a: T, b: T) => churn(b) - churn(a);
export const rankedDirectories = (footprint: Footprint | null) => footprint ? [...footprint.directories].sort(compareByChurn) : [];
export const rankedFiles = (footprint: Footprint | null) => footprint ? [...footprint.files].sort(compareByChurn) : [];

export function formatFootprintSummary(footprint: Footprint | null): string {
  if (!footprint) return "footprint unavailable";
  if (footprint.totalFiles === 0) return "no file changes yet";
  const files = `${footprint.totalFiles} ${footprint.totalFiles === 1 ? "file" : "files"}`;
  const dirs = `${footprint.totalDirectories} ${footprint.totalDirectories === 1 ? "dir" : "dirs"}`;
  const hot = footprint.hottestDirectory;
  return `${files} across ${dirs}${hot ? `, hottest: ${hot.path} +${hot.added}/−${hot.removed}` : ""}`;
}
export function footprintNote(footprint: Footprint | null): string {
  if (!footprint) return "";
  return [footprint.truncated ? "showing top changed files" : "", footprint.skippedNodes ? `${footprint.skippedNodes} node ${footprint.skippedNodes === 1 ? "was" : "were"} unavailable` : ""].filter(Boolean).join(" · ");
}
export const footprintNodeKey = (nodeId: string, iteration: number) => iteration === 0 ? nodeId : `${nodeId}::${iteration}`;

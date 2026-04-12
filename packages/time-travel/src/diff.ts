import type { ParsedSnapshot } from "./ParsedSnapshot";
import type { SnapshotDiff } from "./SnapshotDiff";
import type { Snapshot } from "./snapshot/Snapshot";
/**
 * Compute a structured diff between two parsed snapshots.
 */
export declare function diffSnapshots(a: ParsedSnapshot, b: ParsedSnapshot): SnapshotDiff;
/**
 * Convenience: diff two raw Snapshot rows.
 */
export declare function diffRawSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff;
/**
 * Colorized terminal output for a snapshot diff.
 */
export declare function formatDiffForTui(diff: SnapshotDiff): string;
/**
 * Structured JSON output for a snapshot diff.
 */
export declare function formatDiffAsJson(diff: SnapshotDiff): object;

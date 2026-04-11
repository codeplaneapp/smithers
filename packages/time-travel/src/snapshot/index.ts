export { captureSnapshot, captureSnapshotEffect } from "./captureSnapshotEffect";
export {
  loadLatestSnapshot,
  loadLatestSnapshotEffect,
  loadSnapshot,
  loadSnapshotEffect,
} from "./loadSnapshotEffect";
export { listSnapshots, listSnapshotsEffect } from "./listSnapshotsEffect";

export type { Snapshot } from "./Snapshot";
export type { SnapshotData } from "./SnapshotData";

import type {
  NodeSnapshot,
  ParsedSnapshot,
  RalphSnapshot,
  Snapshot,
} from "../types";

export function parseSnapshot(snapshot: Snapshot): ParsedSnapshot {
  const nodesArr: NodeSnapshot[] = JSON.parse(snapshot.nodesJson);
  const nodes: Record<string, NodeSnapshot> = {};
  for (const node of nodesArr) {
    nodes[`${node.nodeId}::${node.iteration}`] = node;
  }

  const ralphArr: RalphSnapshot[] = JSON.parse(snapshot.ralphJson);
  const ralph: Record<string, RalphSnapshot> = {};
  for (const entry of ralphArr) {
    ralph[entry.ralphId] = entry;
  }

  return {
    runId: snapshot.runId,
    frameNo: snapshot.frameNo,
    nodes,
    outputs: JSON.parse(snapshot.outputsJson),
    ralph,
    input: JSON.parse(snapshot.inputJson),
    vcsPointer: snapshot.vcsPointer,
    workflowHash: snapshot.workflowHash,
    contentHash: snapshot.contentHash,
    createdAtMs: snapshot.createdAtMs,
  };
}

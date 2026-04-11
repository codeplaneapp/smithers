import type { Snapshot } from "./Snapshot";
import type { ParsedSnapshot } from "../ParsedSnapshot";
import type { NodeSnapshot } from "../NodeSnapshot";
import type { RalphSnapshot } from "../RalphSnapshot";

export function parseSnapshot(snapshot: Snapshot): ParsedSnapshot {
  const nodesArr: NodeSnapshot[] = JSON.parse(snapshot.nodesJson);
  const nodes: Record<string, NodeSnapshot> = {};
  for (const n of nodesArr) {
    nodes[`${n.nodeId}::${n.iteration}`] = n;
  }

  const ralphArr: RalphSnapshot[] = JSON.parse(snapshot.ralphJson);
  const ralph: Record<string, RalphSnapshot> = {};
  for (const r of ralphArr) {
    ralph[r.ralphId] = r;
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

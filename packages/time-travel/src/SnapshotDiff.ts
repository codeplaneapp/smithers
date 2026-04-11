import type { NodeChange } from "./NodeChange";
import type { OutputChange } from "./OutputChange";
import type { RalphChange } from "./RalphChange";

/**
 * Structured diff between two snapshots.
 */
export type SnapshotDiff = {
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesChanged: NodeChange[];
  outputsAdded: string[];
  outputsRemoved: string[];
  outputsChanged: OutputChange[];
  ralphChanged: RalphChange[];
  inputChanged: boolean;
  vcsPointerChanged: boolean;
};

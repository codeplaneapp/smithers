import type { NodeSnapshot } from "./NodeSnapshot";

export type NodeChange = {
  nodeId: string;
  from: NodeSnapshot;
  to: NodeSnapshot;
};

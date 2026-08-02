/** @jsxImportSource react */
import { type ReactNode } from "react";
import { useGatewayRunTree } from "@smthrs/gateway-react";
import { StageStrip, type StageStripProps } from "@smthrs/ui";
import { nodeStatusIndex } from "./runNodeStatus";

export type NodeStageStripStage = {
  /** The workflow node id backing this stage. */
  nodeId: string;
  /** Chip label; defaults to the node id. */
  label?: ReactNode;
};

export type NodeStageStripProps = Omit<StageStripProps, "stages"> & {
  /** The run whose node statuses drive the chips. */
  runId: string | undefined;
  /** Ordered pipeline stages, one per top-level workflow node. */
  stages: ReadonlyArray<NodeStageStripStage>;
  /**
   * Test seam: the run-tree hook to read from. Defaults to
   * {@link useGatewayRunTree}.
   * @internal
   */
  useRunTree?: typeof useGatewayRunTree;
};

/**
 * {@link StageStrip} bound to live node statuses: pass the run and the ordered
 * pipeline node ids, and each chip tracks its node through the run tree
 * (`queued → running → done/failed`). Replaces the hand-rolled label+pill rows
 * workflow UIs kept reinventing for their `preflight → spec → deploy` headers.
 *
 * @example
 * <NodeStageStrip
 *   runId={runId}
 *   stages={[{ nodeId: "preflight" }, { nodeId: "spec-write", label: "spec" }, { nodeId: "deploy" }]}
 * />
 */
export function NodeStageStrip({ runId, stages, useRunTree = useGatewayRunTree, ...stripProps }: NodeStageStripProps) {
  const tree = useRunTree(runId);
  const statuses = nodeStatusIndex(tree.nodes);
  return (
    <StageStrip
      stages={stages.map((stage) => ({
        label: stage.label ?? stage.nodeId,
        status: statuses.get(stage.nodeId) ?? "pending",
      }))}
      {...stripProps}
    />
  );
}

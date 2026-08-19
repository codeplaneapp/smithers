import * as Context from "effect/Context";
import type { CompiledNode } from "./types.ts";

/**
 * Smithers node identity, carried on the compiled flow declaration.
 *
 * Step identity in flows is the content hash: `PlanNode.key`. Nothing about a
 * Smithers node id enters that hash, and nothing should — renaming a task must
 * not re-key it. But the gateway, the UI, and the CLI address nodes by the ids
 * they already display, so the mapping has to survive compilation somewhere.
 * It survives here, as a flow annotation, which is the flows-native place for
 * a declaration to carry data the engine does not interpret.
 */
export type SmithersNodeIndex = {
  /** Every compiled node, in plan order. */
  readonly nodes: readonly CompiledNode[];
  /** Smithers `nodeId` to plan node id. */
  readonly planNodeIdByNodeId: ReadonlyMap<string, string>;
  /** Plan node id to Smithers `nodeId`. */
  readonly nodeIdByPlanNodeId: ReadonlyMap<string, string>;
  /** Smithers `nodeId` to the flows content hash of its step. */
  readonly keyByNodeId: ReadonlyMap<string, string>;
};

/**
 * The annotation key the index is filed under on the compiled flow.
 *
 * @category annotations
 */
export const SmithersNodes = Context.Service<SmithersNodeIndex>("@smthrs/flows-compile/SmithersNodes");

/**
 * The run and frame a compiled plan was produced from.
 *
 * @category annotations
 */
export type SmithersOrigin = {
  readonly runId: string;
  readonly frameNo: number;
};

/**
 * The annotation key the origin is filed under on the compiled flow.
 *
 * @category annotations
 */
export const SmithersOrigin = Context.Service<SmithersOrigin>("@smthrs/flows-compile/SmithersOrigin");

/** Builds the index a compiled workflow annotates its flow with. */
export const makeNodeIndex = (nodes: readonly CompiledNode[]): SmithersNodeIndex => ({
  nodes,
  planNodeIdByNodeId: new Map(nodes.map((node) => [node.nodeId, node.planNodeId])),
  nodeIdByPlanNodeId: new Map(nodes.map((node) => [node.planNodeId, node.nodeId])),
  keyByNodeId: new Map(nodes.map((node) => [node.nodeId, node.key])),
});

/** The annotations context a compiled flow carries. */
export type CompiledAnnotations = Context.Context<SmithersNodeIndex | SmithersOrigin>;

/** Reads the Smithers node index off a compiled flow. */
export const smithersNodes = (flow: { readonly annotations: unknown }): SmithersNodeIndex =>
  Context.get(flow.annotations as CompiledAnnotations, SmithersNodes);

/** Reads the run and frame a compiled flow was produced from. */
export const smithersOrigin = (flow: { readonly annotations: unknown }): SmithersOrigin =>
  Context.get(flow.annotations as CompiledAnnotations, SmithersOrigin);

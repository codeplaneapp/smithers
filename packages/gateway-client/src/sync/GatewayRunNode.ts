export type GatewayRunNode = {
  id: string;
  name: string;
  cardLabel?: string;
  kind: string;
  status: string;
  /**
   * Loop/retry iteration this node row represents. Sourced from the snapshot's
   * `task.iteration`; absent for container nodes that have no task identity.
   * Consumers thread it into `getNodeOutput`/approval lookups so loops and
   * retries read the right attempt rather than always iteration 0.
   */
  iteration?: number;
  meta?: string;
  agent?: string;
  output?: string;
  toolCalls?: ReadonlyArray<Record<string, unknown>>;
  parentId?: string;
  childIds?: readonly string[];
  children?: GatewayRunNode[];
};

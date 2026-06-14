export type GatewayRunNode = {
  id: string;
  name: string;
  cardLabel?: string;
  kind: string;
  status: string;
  meta?: string;
  agent?: string;
  output?: string;
  toolCalls?: ReadonlyArray<Record<string, unknown>>;
  parentId?: string;
  childIds?: readonly string[];
  children?: GatewayRunNode[];
};

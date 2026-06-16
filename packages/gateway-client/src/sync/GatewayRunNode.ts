import type { GatewayVirtualRow } from "./GatewayVirtualRow.ts";

export type GatewayRunNode = GatewayVirtualRow & {
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

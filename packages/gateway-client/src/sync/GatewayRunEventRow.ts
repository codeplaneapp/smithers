import type { SyncKey } from "./SyncKey.ts";
import type { GatewayVirtualRow } from "./GatewayVirtualRow.ts";

export type GatewayRunEventRow = GatewayVirtualRow & {
  key: SyncKey;
  seq: number;
  event: string;
  payload: unknown;
};

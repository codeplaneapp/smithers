import type { SyncKey } from "./SyncKey.ts";

export type GatewayRunEventRow = {
  key: SyncKey;
  seq: number;
  event: string;
  payload: unknown;
};

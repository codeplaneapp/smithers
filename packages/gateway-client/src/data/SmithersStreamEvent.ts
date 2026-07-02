export type SmithersStreamEvent =
  | { type: "change"; seq: number; collections: string[] }
  | { type: "reset"; seq: number }
  | { type: "heartbeat"; seq: number };

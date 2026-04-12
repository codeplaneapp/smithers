import { replayFromCheckpoint as replayFromCheckpointEffect } from "./replayFromCheckpointEffect";
export type { ReplayResult } from "./ReplayResult";
export { replayFromCheckpointEffect };
export declare function replayFromCheckpoint(...args: Parameters<typeof replayFromCheckpointEffect>): Promise<import("./ReplayResult").ReplayResult>;

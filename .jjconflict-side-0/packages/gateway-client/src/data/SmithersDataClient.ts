import type { WorkspaceMode } from "./WorkspaceMode.ts";
import type { SmithersApi } from "./SmithersApi.ts";
import type { SmithersStreamEvent } from "./SmithersStreamEvent.ts";

export type SmithersDataClient = {
  mode: WorkspaceMode;
  api: SmithersApi;
  stream: {
    subscribe(handler: (event: SmithersStreamEvent) => void): () => void;
    subscribeStatus(handler: () => void): () => void;
    status(): { status: "idle" | "connecting" | "online" | "offline" | "unauthorized"; reconnectingSince?: number };
    waitForSeq(seq: number): Promise<void>;
  };
  close(): void;
};

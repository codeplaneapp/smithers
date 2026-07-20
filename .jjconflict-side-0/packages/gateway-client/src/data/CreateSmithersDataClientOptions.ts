import type { WorkspaceMode } from "./WorkspaceMode.ts";
import type { SmithersStreamError } from "./SmithersStreamError.ts";

export type CreateSmithersDataClientOptions = {
  mode: WorkspaceMode;
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
  /**
   * Structured error channel. Called when the SSE stream disconnects (once per
   * reconnect attempt) or a stream frame fails to parse, so a broken stream is
   * observable rather than reconnecting silently.
   */
  onError?: (error: SmithersStreamError) => void;
};

import type { WorkspaceMode } from "./WorkspaceMode.ts";
import type { SmithersStreamError } from "./SmithersStreamError.ts";

export type CreateSmithersDataClientOptions = {
  mode: WorkspaceMode;
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
  /**
   * Extra headers merged into every `/v1/api/*` request and the change stream
   * (fetch SSE and EventSource alike). The gateway's own content type and
   * `authorization: Bearer <mode.token>` take precedence, matching how
   * `SmithersGatewayClient` treats its `headers` option for RPC.
   */
  headers?: HeadersInit;
  /**
   * Structured error channel. Called when the SSE stream disconnects (once per
   * reconnect attempt) or a stream frame fails to parse, so a broken stream is
   * observable rather than reconnecting silently.
   */
  onError?: (error: SmithersStreamError) => void;
};

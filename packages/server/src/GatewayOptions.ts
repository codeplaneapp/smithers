import type { GatewayAuthConfig } from "./GatewayAuthConfig.js";
import type { GatewayDefaults } from "./GatewayDefaults.js";
import type { GatewayOperatorUiConfig } from "./GatewayOperatorUiConfig.js";
import type { GatewayUiConfig } from "./GatewayUiConfig.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export type GatewayOptions = {
  protocol?: number;
  features?: string[];
  heartbeatMs?: number;
  /**
   * Idle spin-down (spec decision 14). When > 0 and `onIdle` is set, the daemon
   * fires `onIdle` once it has been idle — no WS clients, no in-flight runs, no
   * registered crons or pending timers — for this many milliseconds. Wired by
   * the CLI for autostarted daemons only; 0 (default) never idle-exits.
   */
  idleTimeoutMs?: number;
  /** Called once when the daemon goes idle for `idleTimeoutMs` (graceful shutdown). */
  onIdle?: () => void | Promise<void>;
  auth?: GatewayAuthConfig;
  /**
   * Deliberately trust any Host header on an unauthenticated bind (the daemon
   * equivalent of `smithers gateway --insecure`). Without it, an unauthenticated
   * gateway rejects any non-loopback Host as a DNS-rebinding defense, so binding
   * `--host 0.0.0.0` without a token would 403 every LAN request. Ignored when
   * `auth` is set. Mirrors serve.js's `insecure`.
   */
  insecure?: boolean;
  ui?: GatewayUiConfig;
  /**
   * Optional host-owned HTTP fallback. The Gateway still owns its native
   * /health, /metrics, /workflows, /v1/rpc, /rpc, websocket, webhook, and UI
   * routes; this hook runs before the built-in 404 so an embedding app can
   * serve product-specific HTTP surfaces from the same listener without
   * standing up Express or a second server.
   *
   * Return true after writing the response, false to let Gateway continue.
   */
  routes?: (
    req: IncomingMessage,
    res: ServerResponse,
    context: { gateway: unknown; url: URL },
  ) => boolean | Promise<boolean>;
  /**
   * Absolute path to the workspace root — the directory that holds the
   * `.smithers/` registry (workflows, prompts, components) and `smithers.db`.
   *
   * Disk-backed registry reads (currently the `listPrompts` RPC, which walks
   * `<workspaceRoot>/.smithers/prompts/`) resolve relative to this root rather
   * than `process.cwd()`. Set it whenever the gateway runs with its cwd
   * elsewhere than the workspace — e.g. an app that binds the gateway to an
   * ABSOLUTE workspace DB path without `chdir`-ing into the workspace (the
   * studio dev server passes `SMITHERS_STUDIO_WORKSPACE` here). When omitted,
   * these reads fall back to `process.cwd()`, which is correct for the common
   * case where the gateway boots from the workspace root.
   */
  workspaceRoot?: string;
  /**
   * Identity advertised on `GET /health`, the `health` RPC, and the WS hello
   * (together with `workspaceRoot`, the process pid, and the listen time).
   * Clients use it to verify they reached the gateway for the workspace they
   * resolved locally instead of trusting whichever process owns the port.
   */
  identity?: {
    /** Storage backend the workspace store resolved to (sqlite | pglite | postgres). */
    backend?: string;
    /** smithers-orchestrator package version serving this gateway. */
    version?: string;
  };
  /**
   * Built-in browser console for operators. Set to false to disable it.
   * @default { path: "/console" }
   */
  operatorUi?: GatewayOperatorUiConfig | false;
  defaults?: GatewayDefaults;
  maxBodyBytes?: number;
  maxPayload?: number;
  maxConnections?: number;
  /**
   * Per-run replay window for Gateway run event streams.
   * @default 10000
   */
  eventWindowSize?: number;
  /**
   * Bridge persisted run events from the workspace DB into live Gateway streams
   * for runs executed by another process.
   * @default true
   */
  outOfProcessEventBridge?: boolean;
  /**
   * Poll interval (in milliseconds) for the out-of-process event bridge.
   * @default 1000
   */
  outOfProcessEventBridgePollMs?: number;
  /**
   * Maximum time (in milliseconds) allowed for the HTTP parser to receive the
   * complete headers of a single request. Helps mitigate slowloris attacks.
   * @default 30000
   */
  headersTimeout?: number;
  /**
   * Maximum time (in milliseconds) allowed for a single request to be received
   * and parsed, including the body. Helps mitigate slowloris attacks.
   * @default 60000
   */
  requestTimeout?: number;
};

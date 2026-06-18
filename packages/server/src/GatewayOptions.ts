import type { GatewayAuthConfig } from "./GatewayAuthConfig.js";
import type { GatewayDefaults } from "./GatewayDefaults.js";
import type { GatewayOperatorUiConfig } from "./GatewayOperatorUiConfig.js";
import type { GatewayUiConfig } from "./GatewayUiConfig.js";

export type GatewayOptions = {
  protocol?: number;
  features?: string[];
  heartbeatMs?: number;
  auth?: GatewayAuthConfig;
  ui?: GatewayUiConfig;
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

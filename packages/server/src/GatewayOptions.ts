import type { GatewayAuthConfig } from "./GatewayAuthConfig.js";
import type { GatewayDefaults } from "./GatewayDefaults.js";

export type GatewayOptions = {
  protocol?: number;
  features?: string[];
  heartbeatMs?: number;
  auth?: GatewayAuthConfig;
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

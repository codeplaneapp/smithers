import type { HerdrPong } from "./HerdrProtocol.ts";

/** Severity passed to a {@link HerdrLogger}. */
export type HerdrLogLevel = "warn" | "debug";

/**
 * Sink for the client's diagnostics. `"warn"` covers soft failures (a
 * `tryCall()` that failed, a protocol mismatch); `"debug"` covers noisy
 * internals (a dropped subscribe frame, a subscribe-socket reconnect). The
 * default logger prints `"warn"` to `console.warn` and drops `"debug"`.
 */
export type HerdrLogger = (level: HerdrLogLevel, message: string, data?: unknown) => void;

/** Options for {@link createHerdrClient}. */
export type HerdrClientOptions = {
  /** Explicit socket path; wins over every other resolution input. */
  socketPath?: string;
  /** Named herdr session whose socket to use (below `socketPath`). */
  session?: string;
  /** Per-call timeout in milliseconds. Defaults to `5000`. */
  callTimeoutMs?: number;
  /** Diagnostics sink. Defaults to a `console.warn`-backed logger. */
  logger?: HerdrLogger;
};

/** Compatibility policy for {@link HerdrClient.ping}. */
export type HerdrPingOptions = {
  /** Reject with `HerdrError(code="protocol_mismatch")` when the server protocol differs. */
  requireProtocolMatch?: boolean;
};

/**
 * A herdr event delivered to a {@link HerdrClient.subscribe} consumer. `event`
 * is the raw name as received (herdr emits snake_case kinds like
 * `workspace_created`, though some — e.g. `pane.agent_status_changed` — arrive
 * dotted); `type` is the normalized dotted form so consumers can match
 * tolerantly; `data` is the event payload as a loose record.
 */
export type HerdrEvent = {
  event: string;
  type: string;
  data: Record<string, unknown>;
};

/**
 * A single subscription filter, e.g. `{ type: "workspace.created" }` or a
 * per-pane filter `{ type: "pane.agent_status_changed", pane_id }`. Extra keys
 * are forwarded verbatim to herdr.
 */
export type HerdrSubscription = {
  type: string;
  [key: string]: unknown;
};

/** Handle returned by {@link HerdrClient.subscribe}. */
export type HerdrSubscriptionHandle = {
  /** Stop reconnecting and destroy the underlying socket. Idempotent. */
  close(): void;
};

/**
 * A herdr socket client. Each `call()`/`tryCall()` uses its own short-lived
 * connection (herdr serves one request per connection); `subscribe()` holds a
 * dedicated long-lived connection that auto-reconnects.
 */
export type HerdrClient = {
  /** The resolved control-socket path this client connects to. */
  socketPath: string;
  /**
   * Perform one herdr RPC. Rejects with a `HerdrError` on an error frame
   * (including empty-id protocol errors), a per-call timeout, an absent
   * socket, or a connection that closes before responding.
   */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Like {@link HerdrClient.call} but soft-fails: logs a warning and resolves `undefined`. */
  tryCall<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T | undefined>;
  /**
   * Open a long-lived subscription. The first frame is the
   * `subscription_started` ack (not delivered); subsequent event frames are
   * delivered to `onEvent`. The connection auto-reconnects with capped
   * exponential backoff and resubscribes on reconnect.
   */
  subscribe(subscriptions: HerdrSubscription[], onEvent: (event: HerdrEvent) => void): HerdrSubscriptionHandle;
  /**
   * Ping the server. Transport failures remain soft (`undefined`). A protocol
   * mismatch warns by default, or rejects when `requireProtocolMatch` is true.
   */
  ping(options?: HerdrPingOptions): Promise<HerdrPong | undefined>;
};

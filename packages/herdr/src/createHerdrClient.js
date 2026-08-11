import { Socket } from "node:net";
import { HERDR_PROTOCOL } from "./HERDR_PROTOCOL.js";
import { HerdrError } from "./HerdrError.js";
import { createNdjsonDecoder } from "./ndjson.js";
import { resolveSocketPath } from "./resolveSocketPath.js";

/** @typedef {import("./HerdrClientOptions.ts").HerdrClient} HerdrClient */
/** @typedef {import("./HerdrClientOptions.ts").HerdrClientOptions} HerdrClientOptions */
/** @typedef {import("./HerdrClientOptions.ts").HerdrLogger} HerdrLogger */
/** @typedef {import("./HerdrClientOptions.ts").HerdrPingOptions} HerdrPingOptions */
/** @typedef {import("./HerdrClientOptions.ts").HerdrEvent} HerdrEvent */
/** @typedef {import("./HerdrClientOptions.ts").HerdrSubscription} HerdrSubscription */
/** @typedef {import("./HerdrClientOptions.ts").HerdrSubscriptionHandle} HerdrSubscriptionHandle */
/** @typedef {import("./HerdrProtocol.ts").HerdrPong} HerdrPong */

const DEFAULT_CALL_TIMEOUT_MS = 5000;
const SUBSCRIBE_MIN_BACKOFF_MS = 250;
const SUBSCRIBE_MAX_BACKOFF_MS = 5000;

let requestSeq = 0;
function nextRequestId() {
  requestSeq += 1;
  return `smithers-${requestSeq}`;
}

/**
 * Normalize a herdr event name to its dotted namespace form so consumers can
 * match tolerantly. herdr emits snake_case kinds (`workspace_created`) that
 * differ from the dotted subscription `type` strings (`workspace.created`), and
 * at least one event (`pane.agent_status_changed`) already arrives dotted;
 * already-dotted names pass through unchanged.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeHerdrEventName(name) {
  if (typeof name !== "string" || name.includes(".")) {
    return name;
  }
  const underscore = name.indexOf("_");
  return underscore < 0 ? name : `${name.slice(0, underscore)}.${name.slice(underscore + 1)}`;
}

/**
 * @param {HerdrLogger | undefined} logger
 * @returns {HerdrLogger}
 */
function makeLogger(logger) {
  if (logger) {
    return logger;
  }
  return (level, message, data) => {
    if (level !== "warn") {
      return;
    }
    if (data === undefined) {
      console.warn(`[herdr] ${message}`);
    } else {
      console.warn(`[herdr] ${message}`, data);
    }
  };
}

/**
 * Perform one herdr RPC on a fresh connection: connect, write one request line,
 * read the one response frame, close. herdr serves one request per connection,
 * so the first frame is the response and there is no id multiplexing.
 *
 * @param {string} socketPath
 * @param {string} method
 * @param {Record<string, unknown> | undefined} params
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
function rpcCall(socketPath, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const decoder = createNdjsonDecoder();
    let settled = false;
    // Construct the socket unconnected and attach every listener before
    // initiating the connection. A failed connect (ENOENT/ECONNREFUSED) can
    // emit "error" synchronously during connect(); attaching first guarantees
    // we observe it and reject with the real errno code rather than letting
    // "close" win and mislabel the failure as "closed".
    const socket = new Socket();

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(new HerdrError(`herdr call ${method} timed out after ${timeoutMs}ms`, { method, code: "timeout" }));
    }, timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    /**
     * @param {"resolve" | "reject"} kind
     * @param {unknown} value
     */
    const settle = (kind, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (kind === "resolve") {
        resolve(value);
      } else {
        reject(value);
      }
    };

    socket.on("error", (err) => {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      settle(
        "reject",
        new HerdrError(`herdr socket error for ${method}: ${err.message}`, {
          method,
          code: code ?? "socket_error",
          cause: err,
        }),
      );
    });

    socket.on("data", (chunk) => {
      let lines;
      try {
        lines = decoder.push(chunk);
      } catch (err) {
        settle(
          "reject",
          new HerdrError(`herdr ${method} returned an oversized response frame`, {
            method,
            code: "frame_too_large",
            cause: err,
          }),
        );
        return;
      }
      if (lines.length === 0) {
        return;
      }
      let frame;
      try {
        frame = JSON.parse(lines[0]);
      } catch (err) {
        settle(
          "reject",
          new HerdrError(`herdr ${method} returned an unparseable response frame`, {
            method,
            code: "invalid_response",
            cause: err,
          }),
        );
        return;
      }
      if (frame && typeof frame === "object" && frame.error) {
        const body = frame.error;
        settle(
          "reject",
          new HerdrError(`herdr ${method} failed: ${body?.message ?? "unknown error"}`, {
            method,
            code: typeof body?.code === "string" ? body.code : undefined,
            cause: body,
          }),
        );
        return;
      }
      settle("resolve", frame && typeof frame === "object" ? frame.result : undefined);
    });

    socket.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new HerdrError(`herdr connection closed before responding to ${method}`, { method, code: "closed" }));
    });

    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify({ id: nextRequestId(), method, params: params ?? {} })}\n`);
      } catch (err) {
        settle(
          "reject",
          new HerdrError(`herdr ${method} request could not be serialized`, {
            method,
            code: "invalid_request",
            cause: err,
          }),
        );
      }
    });

    socket.connect(socketPath);
  });
}

/**
 * Create a herdr socket client. One short-lived connection per
 * `call()`/`tryCall()`; a dedicated long-lived, auto-reconnecting connection
 * per `subscribe()`.
 *
 * @param {HerdrClientOptions} [opts]
 * @returns {HerdrClient}
 */
export function createHerdrClient(opts = {}) {
  const socketPath = resolveSocketPath(opts);
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const log = makeLogger(opts.logger);

  /**
   * @template [T=unknown]
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<T>}
   */
  const call = (method, params) => /** @type {Promise<T>} */ (rpcCall(socketPath, method, params, callTimeoutMs));

  /**
   * @template [T=unknown]
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<T | undefined>}
   */
  const tryCall = async (method, params) => {
    try {
      return /** @type {T} */ (await rpcCall(socketPath, method, params, callTimeoutMs));
    } catch (err) {
      log("warn", `herdr ${method} failed (soft): ${err instanceof Error ? err.message : String(err)}`, err);
      return undefined;
    }
  };

  /**
   * @param {HerdrSubscription[]} subscriptions
   * @param {(event: HerdrEvent) => void} onEvent
   * @returns {HerdrSubscriptionHandle}
   */
  const subscribe = (subscriptions, onEvent) => {
    let closed = false;
    /** @type {import("node:net").Socket | null} */
    let socket = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let reconnectTimer = null;
    let backoffMs = SUBSCRIBE_MIN_BACKOFF_MS;

    function scheduleReconnect() {
      if (closed || reconnectTimer) {
        return;
      }
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, SUBSCRIBE_MAX_BACKOFF_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
      if (typeof reconnectTimer.unref === "function") {
        reconnectTimer.unref();
      }
    }

    function connect() {
      if (closed) {
        return;
      }
      const decoder = createNdjsonDecoder();
      let ackSeen = false;
      // Attach listeners before connecting: a synchronous connect error
      // (e.g. a missing socket) would otherwise escape as an unhandled
      // "error" before the handler below is registered.
      const active = new Socket();
      socket = active;

      active.on("connect", () => {
        try {
          active.write(
            `${JSON.stringify({ id: nextRequestId(), method: "events.subscribe", params: { subscriptions } })}\n`,
          );
        } catch (err) {
          log("warn", "herdr subscription request could not be serialized", err);
          active.destroy();
        }
      });

      active.on("data", (chunk) => {
        let lines;
        try {
          lines = decoder.push(chunk);
        } catch (err) {
          log("warn", "herdr subscription closed after an oversized frame", err);
          active.destroy();
          return;
        }
        for (const line of lines) {
          let frame;
          try {
            frame = JSON.parse(line);
          } catch (err) {
            log("debug", "herdr subscribe dropped an unparseable frame", err);
            continue;
          }
          if (!ackSeen) {
            ackSeen = true;
            if (frame?.error) {
              // A rejected subscription (e.g. a per-pane filter missing
              // pane_id) gets an error frame and the server closes the
              // connection. Do NOT reset backoff here, or the reconnect
              // loop would busy-spin at the floor interval forever.
              log("warn", `herdr subscription rejected: ${frame.error?.message ?? "unknown error"}`, frame.error);
              continue;
            }
            // A working subscription (the ack, or a first live event):
            // reset backoff so a later drop recovers quickly.
            backoffMs = SUBSCRIBE_MIN_BACKOFF_MS;
            if (frame?.result?.type === "subscription_started") {
              continue;
            }
          }
          if (frame && typeof frame.event === "string") {
            /** @type {HerdrEvent} */
            const event = {
              event: frame.event,
              type: normalizeHerdrEventName(frame.event),
              data: frame.data && typeof frame.data === "object" ? frame.data : {},
            };
            try {
              onEvent(event);
            } catch (err) {
              log("debug", "herdr subscribe onEvent handler threw", err);
            }
          }
        }
      });

      active.on("error", (err) => {
        log("debug", `herdr subscribe socket error: ${err instanceof Error ? err.message : String(err)}`, err);
      });

      active.on("close", () => {
        if (socket === active) {
          socket = null;
        }
        scheduleReconnect();
      });

      active.connect(socketPath);
    }

    connect();

    return {
      close() {
        if (closed) {
          return;
        }
        closed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (socket) {
          socket.destroy();
          socket = null;
        }
      },
    };
  };

  /**
   * @param {HerdrPingOptions} [options]
   * @returns {Promise<HerdrPong | undefined>}
   */
  const ping = async (options = {}) => {
    const pong = /** @type {HerdrPong | undefined} */ (await tryCall("ping", {}));
    if (pong && pong.protocol !== HERDR_PROTOCOL) {
      const message = `herdr protocol mismatch: client expects ${HERDR_PROTOCOL}, server reports ${pong.protocol}`;
      log("warn", message, pong);
      if (options.requireProtocolMatch === true) {
        throw new HerdrError(message, { method: "ping", code: "protocol_mismatch", cause: pong });
      }
    }
    return pong;
  };

  return { socketPath, call, tryCall, subscribe, ping };
}

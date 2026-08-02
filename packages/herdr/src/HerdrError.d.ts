/**
 * Error thrown by a herdr client's `call()` when a request fails: an error
 * frame returned by the server (including protocol-level empty-id error frames),
 * a per-call timeout, an absent/unreachable socket, or a connection that closes
 * before responding. `tryCall()` swallows this and returns `undefined`.
 */
declare class HerdrError extends Error {
    /**
     * @param {string} message
     * @param {{ method?: string, code?: string, cause?: unknown }} [info]
     */
    constructor(message: string, info?: {
        method?: string;
        code?: string;
        cause?: unknown;
    });
    /**
     * The herdr method that failed, when known.
     * @type {string | undefined}
     */
    method: string | undefined;
    /**
     * A machine-readable code: the herdr `error.code` for server error
     * frames, the socket errno (e.g. `"ENOENT"`) for connection failures, or
     * one of `"timeout"` / `"closed"` / `"invalid_response"` / `"socket_error"`.
     * @type {string | undefined}
     */
    code: string | undefined;
    cause: unknown;
}

export { HerdrError };

// Wire shapes for the gateway-extensions surface. Mirrors the server-side
// envelopes in `packages/server/src/GatewayExtensions.js` so a single UI can
// import these and stay typed end to end.

export const GATEWAY_EXTENSION_METHOD_PREFIX = "ext.";
export const GATEWAY_EXTENSION_STREAM_METHOD_PREFIX = "ext.stream.";
export const GATEWAY_EXTENSION_STREAM_EVENT = "ext.stream.event";
export const GATEWAY_EXTENSION_STREAM_ERROR = "ext.stream.error";

/**
 * Typed error codes the gateway emits for the extension surface. UI code can
 * key off these rather than parsing message text — `EXTENSION_METHOD_NOT_FOUND`
 * means the `(namespace, key)` pair didn't resolve; `BackpressureDisconnect`
 * means the per-subscriber outbound queue overflowed and the stream was torn
 * down by the gateway (the React hook will reconnect with backoff).
 */
export const GATEWAY_EXTENSION_METHOD_NOT_FOUND_CODE = "EXTENSION_METHOD_NOT_FOUND";
export const GATEWAY_EXTENSION_BACKPRESSURE_DISCONNECT_CODE = "BackpressureDisconnect";
export const GATEWAY_EXTENSION_PAYLOAD_TOO_LARGE_CODE = "PayloadTooLarge";

export type GatewayExtensionStreamFrame<T = unknown> = {
  streamId: string;
  namespace: string;
  key: string;
  payload: T;
};

export type GatewayExtensionStreamErrorFrame = {
  streamId: string;
  namespace: string;
  key: string;
  error: {
    version: string;
    code: string;
    message: string;
  };
};

export type GatewayExtensionSubscribeResponse<T = unknown> = {
  streamId: string;
  namespace: string;
  key: string;
  initial?: T;
};

export function extensionMethodName(namespace: string, key: string): string {
  return `${GATEWAY_EXTENSION_METHOD_PREFIX}${namespace}.${key}`;
}

export function extensionStreamMethodName(namespace: string, key: string): string {
  return `${GATEWAY_EXTENSION_STREAM_METHOD_PREFIX}${namespace}.${key}`;
}

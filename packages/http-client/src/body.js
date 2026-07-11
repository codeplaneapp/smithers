import { HttpClientPolicyError } from "./errors.js";

/**
 * @param {number} maxBytes
 */
function assertMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new HttpClientPolicyError(
      "INVALID_OPTION",
      "Response byte limit must be a non-negative safe integer.",
      { option: "maxBytes" },
    );
  }
}

/**
 * @param {AbortSignal} signal
 * @returns {unknown}
 */
function abortReason(signal) {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/**
 * @param {Response} response
 * @param {import("./types.ts").ResponseReadOptions} options
 * @returns {Promise<Uint8Array>}
 */
export async function readResponseBytes(response, options) {
  const { maxBytes, signal } = options;
  assertMaxBytes(maxBytes);
  if (signal?.aborted) {
    await response.body?.cancel(abortReason(signal)).catch(() => undefined);
    throw abortReason(signal);
  }

  const contentLengthRaw = response.headers.get("content-length");
  if (contentLengthRaw !== null && /^\d+$/.test(contentLengthRaw.trim())) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
      const error = new HttpClientPolicyError(
        "RESPONSE_TOO_LARGE",
        "Outbound response exceeds the configured byte limit.",
        { maxBytes, contentLength },
      );
      await response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let totalBytes = 0;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void reader.cancel(abortReason(/** @type {AbortSignal} */ (signal))).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted || aborted) throw abortReason(/** @type {AbortSignal} */ (signal));
      let result;
      try {
        result = await reader.read();
      } catch (error) {
        if (signal?.aborted || aborted) throw abortReason(/** @type {AbortSignal} */ (signal));
        throw error;
      }
      const { value, done } = result;
      if (signal?.aborted || aborted) throw abortReason(/** @type {AbortSignal} */ (signal));
      if (done) break;
      if (!value) continue;
      const chunkBytes = value.byteLength;
      if (totalBytes + chunkBytes > maxBytes) {
        const error = new HttpClientPolicyError(
          "RESPONSE_TOO_LARGE",
          "Outbound response exceeds the configured byte limit.",
          { maxBytes, receivedBytes: totalBytes + chunkBytes },
        );
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      // Own the bytes we retain. A custom stream producer may reuse/mutate its
      // backing buffer after enqueueing a view.
      const chunk = new Uint8Array(value);
      chunks.push(chunk);
      totalBytes += chunkBytes;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * @param {Response} response
 * @param {import("./types.ts").ResponseReadOptions} options
 * @returns {Promise<string>}
 */
export async function readResponseText(response, options) {
  return new TextDecoder().decode(await readResponseBytes(response, options));
}

/**
 * @template [T=unknown]
 * @param {Response} response
 * @param {import("./types.ts").ResponseReadOptions} options
 * @returns {Promise<T>}
 */
export async function readResponseJson(response, options) {
  return /** @type {T} */ (JSON.parse(await readResponseText(response, options)));
}

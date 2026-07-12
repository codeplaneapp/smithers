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
 * A custom Fetch adapter can ignore stream cancellation. Race each read with
 * the caller's signal so the response deadline remains real even then.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {AbortSignal | undefined} signal
 */
function readChunk(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
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
    void response.body?.cancel(abortReason(signal)).catch(() => undefined);
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
      void response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let totalBytes = 0;
  let aborted = false;
  let failed = false;
  let failure;
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
        result = await readChunk(reader, signal);
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
        void reader.cancel(error).catch(() => undefined);
        throw error;
      }
      // Own the bytes we retain. A custom stream producer may reuse/mutate its
      // backing buffer after enqueueing a view.
      const chunk = new Uint8Array(value);
      chunks.push(chunk);
      totalBytes += chunkBytes;
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch (error) {
      // A hostile adapter may leave reader.read() pending after cancellation.
      // Preserve the caller's exact abort reason rather than replacing it with
      // releaseLock's secondary state error.
      if (!signal?.aborted && !aborted && !failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;

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
  return new TextDecoder("utf-8", { fatal: true }).decode(await readResponseBytes(response, options));
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

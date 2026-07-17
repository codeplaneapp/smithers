/**
 * Read a response body into memory while enforcing a byte limit and preserving
 * abort propagation. The caller supplies the overflow error so each public
 * tool can retain its own error vocabulary.
 *
 * @param {Response} response
 * @param {{
 *   maxBytes: number,
 *   signal?: AbortSignal,
 *   createTooLargeError: (maxBytes: number) => Error,
 * }} options
 * @returns {Promise<Uint8Array>}
 */
export async function readBoundedResponseBody(response, options) {
  const { maxBytes, signal, createTooLargeError } = options;
  const body = response.body;
  if (signal?.aborted) {
    await cancelResponseBody(body, signal.reason);
    signal.throwIfAborted();
  }
  if (declaredContentLengthExceedsLimit(response.headers.get("content-length"), maxBytes)) {
    const error = createTooLargeError(maxBytes);
    await cancelResponseBody(body, error);
    throw error;
  }
  if (body === null) return new Uint8Array();

  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let totalBytes = 0;
  /** @type {Promise<void> | undefined} */
  let abortCancellation;
  const cancelOnAbort = () => {
    abortCancellation = cancelResponseReader(reader, signal?.reason);
  };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        const error = createTooLargeError(maxBytes);
        await cancelResponseReader(reader, error);
        throw error;
      }
      chunks.push(value);
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    await abortCancellation;
    reader.releaseLock();
  }

  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * @param {string | null} contentLength
 * @param {number} maxBytes
 */
function declaredContentLengthExceedsLimit(contentLength, maxBytes) {
  if (contentLength === null) return false;
  const normalized = contentLength.trim();
  if (!/^\d+$/.test(normalized)) return false;
  return BigInt(normalized) > BigInt(maxBytes);
}

/**
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {unknown} reason
 */
async function cancelResponseBody(body, reason) {
  if (body === null) return;
  try {
    await body.cancel(reason);
  } catch {
    // Preserve the overflow/abort error even if transport cleanup fails.
  }
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {unknown} reason
 */
async function cancelResponseReader(reader, reason) {
  try {
    await reader.cancel(reason);
  } catch {
    // Preserve the overflow/abort error even if transport cleanup fails.
  }
}

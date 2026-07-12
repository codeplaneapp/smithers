import { timingSafeEqual } from "node:crypto";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const ALLOWED_PATH = /^\/v1\/messages(?:\/count_tokens)?$/;

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("inference request aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("inference request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function boundedBody(request: Request, signal: AbortSignal): Promise<Uint8Array> {
  const header = request.headers.get("content-length");
  if (header !== null && (!/^(?:0|[1-9]\d*)$/.test(header) || Number(header) > MAX_REQUEST_BYTES)) {
    throw new Error("request body is too large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_REQUEST_BYTES) throw new Error("request body is too large");
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* a hostile client may retain a pending read */ }
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1");
}

function authorized(supplied: string, expected: string): boolean {
  if (supplied.length < 1 || supplied.length > 256 || /[^\x21-\x7e]/.test(supplied)) return false;
  const suppliedBytes = Buffer.from(supplied, "ascii");
  const expectedBytes = Buffer.from(expected, "ascii");
  if (suppliedBytes.byteLength !== expectedBytes.byteLength) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

function boundedUpstreamBody(
  upstream: Response,
  controller: AbortController,
  cleanup: () => void,
): ReadableStream<Uint8Array> | null {
  const declared = upstream.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    const error = new Error("inference upstream response is oversized");
    controller.abort(error);
    void upstream.body?.cancel(error).catch(() => undefined);
    throw error;
  }
  if (!upstream.body) { cleanup(); return null; }
  const reader = upstream.body.getReader();
  let total = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    controller.signal.removeEventListener("abort", abortReader);
    cleanup();
  };
  const abortReader = () => { void reader.cancel(controller.signal.reason).catch(() => undefined); };
  controller.signal.addEventListener("abort", abortReader, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(target) {
      try {
        const next = await abortable(reader.read(), controller.signal);
        if (next.done) {
          finish();
          target.close();
          return;
        }
        total += next.value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw new Error("inference upstream response is oversized");
        target.enqueue(next.value);
      } catch (error) {
        void reader.cancel(error).catch(() => undefined);
        finish();
        target.error(new Error("inference upstream response failed"));
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
      finish();
    },
  });
}

export interface InferenceBroker {
  baseUrl: string;
  clientKey: string;
  stop(): void;
}

/** Keep the metered token in the trusted parent and expose one loopback route. */
export function startInferenceBroker(input: {
  upstreamBaseUrl: string;
  sessionToken: string;
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
}): InferenceBroker {
  if (typeof input.upstreamBaseUrl !== "string" || input.upstreamBaseUrl.length < 1 || input.upstreamBaseUrl.length > 2_048) {
    throw new Error("inference broker upstream URL is invalid");
  }
  const upstreamBase = new URL(input.upstreamBaseUrl);
  if ((upstreamBase.protocol !== "https:" && !isLoopback(upstreamBase))
    || upstreamBase.username || upstreamBase.password || upstreamBase.search || upstreamBase.hash) {
    throw new Error("inference broker upstream must be credential-free HTTPS (or loopback HTTP)");
  }
  if (typeof input.sessionToken !== "string" || input.sessionToken.length < 1 || input.sessionToken.length > 8_192
    || /[^\x21-\x7e]/.test(input.sessionToken)) throw new Error("inference broker session token is invalid");
  const deadline = input.deadlineMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 10 * 60_000) throw new Error("inference broker deadline is invalid");

  const clientKey = `local_${crypto.randomUUID()}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const active = new Set<AbortController>();
  let stopped = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (stopped) return new Response("broker stopped", { status: 503 });
      const incoming = new URL(request.url);
      const supplied = request.headers.get("x-api-key")
        ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
        ?? "";
      if (!authorized(supplied, clientKey)) return new Response("unauthorized", { status: 401 });
      if (request.method !== "POST" || !ALLOWED_PATH.test(incoming.pathname) || incoming.search) {
        return new Response("route not allowed", { status: 404 });
      }

      const controller = new AbortController();
      active.add(controller);
      const timer = setTimeout(() => controller.abort(new Error("inference upstream deadline exceeded")), deadline);
      const clientAbort = () => controller.abort(new Error("inference client disconnected"));
      request.signal.addEventListener("abort", clientAbort, { once: true });
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", clientAbort);
        active.delete(controller);
      };
      try {
        const body = await boundedBody(request, controller.signal);
        const upstreamUrl = new URL(
          incoming.pathname.replace(/^\//, ""),
          `${upstreamBase.toString().replace(/\/$/, "")}/`,
        );
        if (upstreamUrl.origin !== upstreamBase.origin) throw new Error("inference upstream route escaped its origin");
        const headers = new Headers();
        for (const name of ["accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent"]) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        headers.set("x-api-key", input.sessionToken);
        const upstream = await abortable(fetchImpl(upstreamUrl, {
          method: "POST",
          redirect: "error",
          headers,
          body,
          signal: controller.signal,
        }), controller.signal);
        const responseHeaders = new Headers();
        for (const name of ["cache-control", "content-type", "request-id", "x-request-id"]) {
          const value = upstream.headers.get(name);
          if (value) responseHeaders.set(name, value);
        }
        const responseBody = boundedUpstreamBody(upstream, controller, cleanup);
        return new Response(responseBody, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      } catch (error) {
        cleanup();
        if (error instanceof Error && error.message === "request body is too large") {
          return new Response(error.message, { status: 413 });
        }
        return new Response("inference upstream unavailable", { status: 502 });
      }
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    clientKey,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const controller of active) controller.abort(new Error("inference broker stopped"));
      active.clear();
      server.stop(true);
    },
  };
}

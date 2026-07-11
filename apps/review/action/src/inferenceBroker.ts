const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const ALLOWED_PATH = /^\/v1\/messages(?:\/count_tokens)?$/;

async function boundedBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new Error("request body is too large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) throw new Error("request body is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1");
}

export interface InferenceBroker {
  baseUrl: string;
  clientKey: string;
  stop(): void;
}

/**
 * Keep the real metered session token in the trusted action process. Claude
 * receives only a random local key and talks to this loopback-only broker,
 * which injects the real credential into the single allowed API route.
 */
export function startInferenceBroker(input: {
  upstreamBaseUrl: string;
  sessionToken: string;
  fetchImpl?: typeof fetch;
}): InferenceBroker {
  const upstreamBase = new URL(input.upstreamBaseUrl);
  if (upstreamBase.protocol !== "https:" && !isLoopback(upstreamBase)) {
    throw new Error("inference broker upstream must use HTTPS");
  }
  const clientKey = `local_${crypto.randomUUID()}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const incoming = new URL(request.url);
      const supplied = request.headers.get("x-api-key")
        ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
        ?? "";
      if (supplied !== clientKey) return new Response("unauthorized", { status: 401 });
      if (request.method !== "POST" || !ALLOWED_PATH.test(incoming.pathname) || incoming.search) {
        return new Response("route not allowed", { status: 404 });
      }

      let body: Uint8Array;
      try {
        body = await boundedBody(request);
      } catch (error) {
        return new Response((error as Error).message, { status: 413 });
      }
      const upstreamUrl = new URL(
        incoming.pathname.replace(/^\//, ""),
        `${upstreamBase.toString().replace(/\/$/, "")}/`,
      );
      const headers = new Headers();
      for (const name of ["accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      headers.set("x-api-key", input.sessionToken);
      let upstream: Response;
      try {
        upstream = await fetchImpl(upstreamUrl, {
          method: "POST",
          redirect: "error",
          headers,
          body,
          signal: request.signal,
        });
      } catch {
        return new Response("inference upstream unavailable", { status: 502 });
      }
      const responseHeaders = new Headers();
      for (const name of ["cache-control", "content-type", "request-id", "x-request-id"]) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    clientKey,
    stop() {
      server.stop(true);
    },
  };
}

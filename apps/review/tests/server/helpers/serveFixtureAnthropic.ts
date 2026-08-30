/**
 * Bun.serve fixture standing in for api.anthropic.com.
 *
 * The handler reports every received request so tests can assert on the
 * forwarded headers (the worker MUST inject the real x-api-key) and replays
 * the response shape the worker is metering — JSON for non-streaming, SSE
 * with message_start/message_delta frames for streaming.
 */
export interface FixtureAnthropic {
  baseUrl: string;
  requests: { url: string; method: string; headers: Record<string, string>; body: string }[];
  stop(): void;
}

export interface FixtureAnthropicResponse {
  status?: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

export function serveFixtureAnthropic(
  response: FixtureAnthropicResponse | ((req: { url: string; method: string }) => FixtureAnthropicResponse),
): FixtureAnthropic {
  const requests: FixtureAnthropic["requests"] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
      const headers: Record<string, string> = {};
      for (const [k, v] of request.headers.entries()) headers[k] = v;
      requests.push({ url: request.url, method: request.method, headers, body });
      const r = typeof response === "function" ? response({ url: request.url, method: request.method }) : response;
      return new Response(r.body, {
        status: r.status ?? 200,
        headers: { "content-type": r.contentType, ...(r.headers ?? {}) },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

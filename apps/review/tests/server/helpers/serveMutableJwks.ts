export interface MutableServedJwks {
  url: string;
  requestCount: number;
  setKeys(keys: Record<string, unknown>[]): void;
  setResponse(body: unknown, status?: number): void;
  setRawJson(body: string, status?: number): void;
  setDelay(delayMs: number): void;
  stop(): void;
}

/**
 * Serve a mutable JWKS document over real HTTP. Tests can rotate the published
 * keys without changing the URL, matching an issuer's production rotation.
 */
export function serveMutableJwks(initialKeys: Record<string, unknown>[]): MutableServedJwks {
  let responseBody: unknown = { keys: initialKeys };
  let rawJson: string | undefined;
  let responseStatus = 200;
  let delayMs = 0;
  const fixture: MutableServedJwks = {
    url: "",
    requestCount: 0,
    setKeys(nextKeys) {
      responseBody = { keys: nextKeys };
      rawJson = undefined;
      responseStatus = 200;
    },
    setResponse(body, status = 200) {
      responseBody = body;
      rawJson = undefined;
      responseStatus = status;
    },
    setRawJson(body, status = 200) {
      rawJson = body;
      responseStatus = status;
    },
    setDelay(nextDelayMs) {
      delayMs = nextDelayMs;
    },
    stop() {},
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/.well-known/jwks") {
        return new Response("Not found", { status: 404 });
      }
      fixture.requestCount += 1;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (rawJson !== undefined) {
        return new Response(rawJson, {
          status: responseStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json(responseBody, { status: responseStatus });
    },
  });
  fixture.url = `http://127.0.0.1:${server.port}/.well-known/jwks`;
  fixture.stop = () => server.stop(true);
  return fixture;
}

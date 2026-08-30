/**
 * Serve a JWKS document at /.well-known/jwks on a random local port. Tests
 * point the worker's `jwksUrl` dep at the returned URL; the keypair stays in
 * memory and stops listening on .stop(). No mocks: real HTTP, real fetch.
 */
export interface ServedJwks {
  url: string;
  stop(): void;
}

export function serveJwks(keys: Record<string, unknown>[]): ServedJwks {
  const body = JSON.stringify({ keys });
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/jwks") {
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}/.well-known/jwks`;
  return {
    url,
    stop() {
      server.stop(true);
    },
  };
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SmithersElectricProxy } from "./createSmithersElectricProxy.ts";

export type ServeSmithersElectricProxyOptions = {
  proxy: SmithersElectricProxy;
  port?: number;
  host?: string;
};

export type SmithersElectricProxyServer = {
  server: Server;
  port: number;
  close(): Promise<void>;
};

function requestUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "electric-proxy.local";
  return `http://${host}${req.url ?? "/"}`;
}

function toFetchRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  // Shape reads are GET/OPTIONS only; no body is forwarded.
  return new Request(requestUrl(req), { method: req.method ?? "GET", headers });
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, response.statusText, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    // Abort the response so the client sees a truncated stream rather than a
    // silently-complete one when Electric forwarding fails mid-stream.
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Run the Smithers Electric proxy as a real Node HTTP server. This is the
 * runnable cloud entry point that fronts `electricsql/electric` with auth,
 * scope, grant-based where filling, rate limits, frame bounds, and
 * metrics/spans (the `/metrics` and `/healthz` routes are served by the proxy).
 */
export function serveSmithersElectricProxy(
  options: ServeSmithersElectricProxyOptions,
): Promise<SmithersElectricProxyServer> {
  const { proxy } = options;
  const server = createServer((req, res) => {
    void proxy
      .fetch(toFetchRequest(req))
      .then((response) => writeFetchResponse(res, response))
      .catch((error) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        }
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "0.0.0.0", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({
        server,
        port,
        close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

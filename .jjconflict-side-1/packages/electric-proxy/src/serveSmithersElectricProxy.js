import { createServer } from "node:http";

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {AbortSignal} [signal]
 * @returns {Request}
 */
function toFetchRequest(req, signal) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  const host = req.headers.host ?? "electric-proxy.local";
  // Shape reads are GET/OPTIONS only; no body is forwarded.
  return new Request(`http://${host}${req.url ?? "/"}`, { method: req.method ?? "GET", headers, signal });
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {Response} response
 * @returns {Promise<void>}
 */
async function writeFetchResponse(req, res, response) {
  /** @type {Record<string, string>} */
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, response.statusText, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  // Electric shape streams are long-lived. If the client disconnects mid-stream,
  // cancelling the reader flows into wrapBody's cancel path (upstream cancel +
  // active-slot release) instead of draining the upstream body into a dead socket.
  // `req` (not `res`) emits `close` reliably on premature disconnect across
  // both Node and Bun's node:http implementation.
  const onClose = () => {
    reader.cancel(new Error("client disconnected")).catch(() => undefined);
  };
  req.once("close", onClose);
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
  } finally {
    req.removeListener("close", onClose);
  }
}

/**
 * Run the Smithers Electric proxy as a real Node HTTP server. This is the
 * runnable cloud entry point that fronts `electricsql/electric` with auth,
 * scope, grant-based where filling, rate limits, frame bounds, and
 * metrics/spans (the `/metrics` and `/healthz` routes are served by the proxy).
 *
 * @param {import("./ServeSmithersElectricProxyOptions.ts").ServeSmithersElectricProxyOptions} options
 * @returns {Promise<import("./ServeSmithersElectricProxyOptions.ts").SmithersElectricProxyServer>}
 */
export function serveSmithersElectricProxy(options) {
  const { proxy } = options;
  const server = createServer((req, res) => {
    const controller = new AbortController();
    req.once("close", () => controller.abort());
    void proxy
      .fetch(toFetchRequest(req, controller.signal))
      .then((response) => writeFetchResponse(req, res, response))
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
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

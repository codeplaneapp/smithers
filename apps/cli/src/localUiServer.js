import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * The full local Smithers UI — `apps/smithers`. The CLI builds it (if a source
 * tree is present and the bundle is stale) and serves the bundle from a small
 * static server that reverse-proxies the gateway's RPC/WS/health paths so the
 * app runs same-origin with the gateway (its WebSocket needs same-origin).
 *
 * Resolution order for the app:
 *   1. A prebuilt bundle shipped beside the CLI (`apps/cli/ui-dist`) — the
 *      published path; no build step, works offline.
 *   2. The in-repo source at `apps/smithers` — built on demand with its own
 *      vite (`apps/smithers/node_modules/.bin/vite build`).
 */
export function resolveLocalUi() {
  const bundledDist = resolve(moduleDir, "..", "ui-dist");
  if (existsSync(join(bundledDist, "index.html"))) {
    return { distDir: bundledDist, appDir: null, viteBin: null };
  }
  // apps/cli/src -> apps/cli -> apps -> apps/smithers
  const appDir = resolve(moduleDir, "..", "..", "smithers");
  if (!existsSync(join(appDir, "package.json"))) {
    return null;
  }
  const viteBin = resolve(appDir, "node_modules", ".bin", "vite");
  return { distDir: resolve(appDir, "dist"), appDir, viteBin };
}

/** Is the built bundle present and newer than the newest source file? */
function bundleIsFresh(distDir, appDir) {
  const indexHtml = join(distDir, "index.html");
  if (!existsSync(indexHtml)) return false;
  if (!appDir) return true; // prebuilt bundle: always fresh
  const builtAt = statSync(indexHtml).mtimeMs;
  let newest = 0;
  const walk = (dir) => {
    for (const name of safeReaddir(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
      } else if (st.mtimeMs > newest) {
        newest = st.mtimeMs;
      }
    }
  };
  walk(join(appDir, "src"));
  // Also consider config files.
  for (const f of ["vite.config.ts", "index.html", "package.json"]) {
    const p = join(appDir, f);
    if (existsSync(p)) {
      const m = statSync(p).mtimeMs;
      if (m > newest) newest = m;
    }
  }
  return builtAt >= newest;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Build the bundle with the app's own vite. Returns true on success. */
function buildBundle(appDir, viteBin) {
  if (!viteBin || !existsSync(viteBin)) {
    process.stderr.write(
      `[smithers] Cannot build the UI: vite is not installed in ${appDir}. Run \`pnpm install\` in the repo, or ship a prebuilt bundle at apps/cli/ui-dist.\n`,
    );
    return false;
  }
  process.stderr.write("[smithers] Building the local UI (vite build)…\n");
  const result = spawnSync(viteBin, ["build"], {
    cwd: appDir,
    stdio: "inherit",
  });
  return result.status === 0;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

// Paths proxied to the gateway. Everything else is served from the bundle.
const GATEWAY_PREFIXES = ["/v1/rpc", "/v1/", "/health", "/workflows"];

function isGatewayPath(pathname) {
  return GATEWAY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

/** Resolve a request path to a file inside dist, guarding against traversal. */
function resolveStaticFile(distDir, pathname) {
  const clean = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(distDir, clean);
  if (!filePath.startsWith(distDir)) return null;
  if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
  return null;
}

/**
 * Serve the bundle and reverse-proxy gateway traffic. Returns the listening
 * server. `gatewayBase` is e.g. `http://127.0.0.1:7331`.
 */
export function startLocalUiServer({ distDir, gatewayBase, port, host = "127.0.0.1" }) {
  const gw = new URL(gatewayBase);
  const gatewayHost = gw.hostname;
  const gatewayPort = Number(gw.port || (gw.protocol === "https:" ? 443 : 80));
  const indexHtml = join(distDir, "index.html");

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (isGatewayPath(url.pathname)) {
      // Reverse-proxy to the gateway, rewriting Host/Origin so the gateway sees
      // a same-origin loopback request (it may reject cross-origin upgrades).
      const headers = { ...req.headers, host: `${gatewayHost}:${gatewayPort}` };
      if (headers.origin) headers.origin = `http://${gatewayHost}:${gatewayPort}`;
      const proxyReq = httpRequest(
        {
          host: gatewayHost,
          port: gatewayPort,
          method: req.method,
          path: req.url,
          headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on("error", () => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("Gateway unreachable");
      });
      req.pipe(proxyReq);
      return;
    }

    // Static bundle. SPA fallback to index.html for client routes.
    const filePath = resolveStaticFile(distDir, url.pathname) ?? indexHtml;
    let body;
    try {
      body = readFileSync(filePath);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const type = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  });

  // WebSocket upgrades (the gateway RPC stream) — splice raw sockets through to
  // the gateway, rewriting the Host/Origin lines to keep it same-origin.
  server.on("upgrade", (req, clientSocket, head) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!isGatewayPath(url.pathname)) {
      clientSocket.destroy();
      return;
    }
    const upstream = netConnect(gatewayPort, gatewayHost, () => {
      let headerLines = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        let value = req.rawHeaders[i + 1];
        const lower = name.toLowerCase();
        if (lower === "host") value = `${gatewayHost}:${gatewayPort}`;
        if (lower === "origin") value = `http://${gatewayHost}:${gatewayPort}`;
        headerLines += `${name}: ${value}\r\n`;
      }
      upstream.write(headerLines + "\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePromise(server));
  });
}

/**
 * Ensure the bundle is built (building from source if needed), then serve it.
 * Returns `{ server, url }`. Throws on unrecoverable errors.
 */
export async function serveLocalUi({ gatewayBase, port, rebuild = false }) {
  const ui = resolveLocalUi();
  if (!ui) {
    throw new Error(
      "Could not locate the Smithers UI app. Expected a prebuilt bundle at apps/cli/ui-dist or the source at apps/smithers.",
    );
  }
  const { distDir, appDir, viteBin } = ui;
  if (rebuild || !bundleIsFresh(distDir, appDir)) {
    if (appDir) {
      const ok = buildBundle(appDir, viteBin);
      if (!ok) throw new Error("Failed to build the local UI bundle.");
    } else if (!existsSync(join(distDir, "index.html"))) {
      throw new Error(`Prebuilt UI bundle missing at ${distDir}.`);
    }
  }
  const server = await startLocalUiServer({ distDir, gatewayBase, port });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return { server, url: `http://127.0.0.1:${actualPort}/`, distDir };
}

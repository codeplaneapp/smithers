import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { LocalWorkspaceReadiness } from "./workspaceState";

/**
 * The DEV-SERVER side of the local workspace contract (`/__smithers/local-workspace`
 * and `/__smithers/local-workspace/readiness`).
 *
 * In production this contract is served by the CLI's local UI server
 * (`apps/cli/src/localUiServer.js` — `checkLocalWorkspaceReadiness`); the app's
 * workspace gate (`WorkspacePicker` / `workspaceStore`) cannot render anything
 * until it resolves. The Vite dev server must speak the same contract or the
 * dev/e2e app is stuck on the picker forever, so this module mirrors the same
 * readiness semantics for the dev proxy: the workspace root must exist, carry a
 * `.smithers/` pack, and the proxied local Gateway must be reachable and scoped
 * to that root.
 */

async function realpathIfPossible(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function gatewayHealth(base: string): Promise<{ reachable: boolean; status: number | null }> {
  if (!base) return { reachable: false, status: null };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    return { reachable: res.ok, status: res.status };
  } catch {
    return { reachable: false, status: null };
  } finally {
    clearTimeout(timeout);
  }
}

/** Check a local workspace root exactly like the CLI local UI server does. */
export async function checkLocalWorkspaceReadinessDev({
  workspaceRoot,
  serverWorkspaceRoot,
  gatewayBase,
}: {
  workspaceRoot: unknown;
  serverWorkspaceRoot: string;
  gatewayBase: string;
}): Promise<LocalWorkspaceReadiness> {
  const input = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  const resolvedRoot = input ? resolve(input) : "";
  const resolvedServerRoot = resolve(serverWorkspaceRoot);
  const base = gatewayBase.replace(/\/+$/, "");

  const invalid = (message: string, missing: string[]): LocalWorkspaceReadiness => ({
    status: "invalid-path",
    workspaceRoot: resolvedRoot,
    serverWorkspaceRoot: resolvedServerRoot,
    gatewayBase: base,
    gatewayReachable: false,
    gatewayStatus: null,
    scopedToSelectedRoot: false,
    missing,
    message,
  });

  if (!input) {
    return invalid("Enter a local workspace root.", ["workspace root"]);
  }

  let rootStat;
  try {
    rootStat = await stat(resolvedRoot);
  } catch {
    return invalid(`No local directory exists at ${resolvedRoot}.`, ["workspace directory"]);
  }
  if (!rootStat.isDirectory()) {
    return invalid(`${resolvedRoot} is not a directory.`, ["workspace directory"]);
  }

  const [canonicalRoot, canonicalServerRoot] = await Promise.all([
    realpathIfPossible(resolvedRoot),
    realpathIfPossible(resolvedServerRoot),
  ]);

  const missing: string[] = [];
  try {
    const pack = await stat(join(canonicalRoot, ".smithers"));
    if (!pack.isDirectory()) missing.push(".smithers/");
  } catch {
    missing.push(".smithers/");
  }

  const health = await gatewayHealth(base);
  const scopedToSelectedRoot = canonicalRoot === canonicalServerRoot;
  let status: LocalWorkspaceReadiness["status"] = "ready";
  let message = "Local workspace is ready.";

  if (missing.length > 0) {
    status = "missing-setup";
    message = `Missing local Smithers setup: ${missing.join(", ")}. Run smithers init in this workspace.`;
  } else if (!health.reachable) {
    status = "gateway-unavailable";
    message = `No local Gateway is reachable at ${base}. Start smithers gateway for this workspace.`;
  } else if (!scopedToSelectedRoot) {
    status = "gateway-mismatch";
    message = `The dev server is proxying a Gateway for ${canonicalServerRoot}, not ${canonicalRoot}. Restart with SMITHERS_WORKSPACE_ROOT=${canonicalRoot} or choose ${canonicalServerRoot}.`;
  }

  return {
    status,
    workspaceRoot: canonicalRoot,
    serverWorkspaceRoot: canonicalServerRoot,
    gatewayBase: base,
    gatewayReachable: health.reachable,
    gatewayStatus: health.status,
    scopedToSelectedRoot,
    missing,
    message,
  };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Connect-style middleware serving the local workspace endpoints on the Vite
 * dev/preview server, with the same response shapes as the CLI local UI server.
 */
export function localWorkspaceDevMiddleware({
  serverWorkspaceRoot,
  gatewayBase,
}: {
  serverWorkspaceRoot: string;
  gatewayBase: string;
}) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__smithers/local-workspace" && (req.method ?? "GET") === "GET") {
      try {
        const readiness = await checkLocalWorkspaceReadinessDev({
          workspaceRoot: serverWorkspaceRoot,
          serverWorkspaceRoot,
          gatewayBase,
        });
        sendJson(res, 200, {
          ok: true,
          defaultWorkspaceRoot: readiness.serverWorkspaceRoot,
          readiness,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (url.pathname === "/__smithers/local-workspace/readiness" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const readiness = await checkLocalWorkspaceReadinessDev({
          workspaceRoot: body.workspaceRoot,
          serverWorkspaceRoot,
          gatewayBase,
        });
        sendJson(res, 200, { ok: true, readiness });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    next();
  };
}

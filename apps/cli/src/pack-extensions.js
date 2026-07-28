import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Pack-declared Gateway extensions (issue #1438).
 *
 * The extension surface has shipped on the client for a while —
 * `SmithersGatewayClient.extensionRpc` plus the `useGatewayExtension*` hooks —
 * but there was no way for a workflow pack to declare the SERVER half that
 * `smithers gateway` would load. That left workflow-owned custom UIs
 * (`.smithers/ui/<key>.tsx`) able to read only what the Gateway already models:
 * runs, nodes, events, approvals. Any domain data of their own (project files,
 * a document tree, a custom query) had no path, and the documented
 * `useGatewayExtensionResource` hook had no reachable counterpart.
 *
 * The workaround was to hand-write a `.smithers/gateway.ts` and run it yourself,
 * which fights the one-gateway-per-workspace singleton that `smithers ui`,
 * `smithers monitor`, and cron discovery all resolve to.
 *
 * So: if the workspace ships `.smithers/gateway-extensions.{ts,tsx,js,mjs}`
 * whose default export maps namespace → GatewayExtensionDefinition, mount each
 * one. Failure is isolated per namespace exactly as it is for workflows — a
 * broken extension disables only itself and never takes the Gateway down.
 *
 * Auth is unchanged: definitions carry their own `scope`/`defaultScope` and go
 * through the same `GatewayExtensions` plumbing as the built-in `evals`
 * namespace, so this makes the existing authorization surface reachable rather
 * than adding a new one.
 */

/** Recognized filenames, in resolution order. */
const CANDIDATES = [
  "gateway-extensions.ts",
  "gateway-extensions.tsx",
  "gateway-extensions.js",
  "gateway-extensions.mjs",
];

/**
 * @param {string} workspace
 * @returns {string | undefined} absolute path, when the workspace declares one
 */
export function findPackExtensionsFile(workspace) {
  for (const name of CANDIDATES) {
    const candidate = join(workspace, ".smithers", name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Import the declaration module. Accepts `export default {...}` or a named
 * `export const extensions = {...}`.
 *
 * @param {string} file
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadPackExtensions(file) {
  const mod = await import(pathToFileURL(file).href);
  const declared = mod?.default ?? mod?.extensions;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    throw new Error(`${file} must default-export an object mapping namespace -> GatewayExtensionDefinition`);
  }
  return /** @type {Record<string, unknown>} */ (declared);
}

/**
 * Discover and mount pack extensions onto a Gateway.
 *
 * @param {{ extend: (namespace: string, definition: unknown) => unknown }} gateway
 * @param {string} workspace
 * @param {{ warn?: (message: string) => void; info?: (message: string) => void }} [log]
 * @returns {Promise<string[]>} namespaces successfully registered
 */
export async function registerPackExtensions(gateway, workspace, log) {
  const file = findPackExtensionsFile(workspace);
  if (!file) return [];

  let declared;
  try {
    declared = await loadPackExtensions(file);
  } catch (error) {
    // A pack that cannot be imported must not stop the Gateway from serving
    // runs — the same contract a broken workflow module gets.
    log?.warn?.(`[gateway] skipped pack extensions (${file}): ${error?.message ?? String(error)}`);
    return [];
  }

  const registered = [];
  for (const [namespace, definition] of Object.entries(declared)) {
    try {
      gateway.extend(namespace, definition);
      registered.push(namespace);
    } catch (error) {
      // Namespace collisions throw by design (two extensions must never
      // silently take over one namespace); isolate rather than abort.
      log?.warn?.(`[gateway] skipped extension "${namespace}": ${error?.message ?? String(error)}`);
    }
  }
  if (registered.length > 0) log?.info?.(`[gateway] pack extensions: ${registered.join(", ")}`);
  return registered;
}

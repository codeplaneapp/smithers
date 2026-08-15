import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWorkflowDirs } from "./workflows.js";

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
 * So: if any discovered workflow pack ships
 * `gateway-extensions.{ts,tsx,js,mjs}` whose default export maps namespace →
 * GatewayExtensionDefinition, mount each one. Failure is isolated per pack and
 * namespace exactly as it is for workflows — a broken extension never takes
 * the Gateway down.
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
 * Return the first supported declaration file in one pack. Candidate order is
 * intentional so a pack can migrate from JS to TS without registering twice.
 *
 * @param {string} packDir
 * @returns {string | undefined} absolute path, when the workspace declares one
 */
function findExtensionsFileInPack(packDir) {
  for (const name of CANDIDATES) {
    const candidate = join(packDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Discover extension declarations from every pack visible to this workspace,
 * in the same precedence order as workflow discovery: local, installed local,
 * global, installed global. A pack appears twice in `resolveWorkflowDirs`
 * (curated and ordinary workflow tiers), so de-duplicate by absolute pack path.
 *
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function findPackExtensionsFiles(workspace, env = process.env) {
  const seen = new Set();
  const files = [];
  for (const { packDir } of resolveWorkflowDirs(workspace, env)) {
    if (!packDir) continue;
    const absolutePackDir = resolve(packDir);
    if (seen.has(absolutePackDir)) continue;
    seen.add(absolutePackDir);
    const file = findExtensionsFileInPack(absolutePackDir);
    if (file) files.push(file);
  }
  return files;
}

/**
 * Backward-compatible single-file probe: returns the highest-precedence pack
 * declaration visible from `workspace`.
 *
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function findPackExtensionsFile(workspace, env = process.env) {
  return findPackExtensionsFiles(workspace, env)[0];
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
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string[]>} namespaces successfully registered
 */
export async function registerPackExtensions(gateway, workspace, log, env = process.env) {
  const registered = [];
  for (const file of findPackExtensionsFiles(workspace, env)) {
    let declared;
    try {
      declared = await loadPackExtensions(file);
    } catch (error) {
      // A pack that cannot be imported must not stop the Gateway from serving
      // runs or prevent lower-precedence packs from registering.
      log?.warn?.(`[gateway] skipped pack extensions (${file}): ${error?.message ?? String(error)}`);
      continue;
    }

    let namespaces;
    try {
      namespaces = Object.keys(declared);
    } catch (error) {
      log?.warn?.(`[gateway] skipped pack extensions (${file}): ${error?.message ?? String(error)}`);
      continue;
    }
    for (const namespace of namespaces) {
      try {
        // Read inside the per-namespace guard so even a throwing property
        // getter cannot suppress healthy sibling extensions.
        gateway.extend(namespace, declared[namespace]);
        registered.push(namespace);
      } catch (error) {
        // Namespace collisions throw by design (two extensions must never
        // silently take over one namespace); higher-precedence packs win.
        log?.warn?.(`[gateway] skipped extension "${namespace}" from ${file}: ${error?.message ?? String(error)}`);
      }
    }
  }
  if (registered.length > 0) log?.info?.(`[gateway] pack extensions: ${registered.join(", ")}`);
  return registered;
}

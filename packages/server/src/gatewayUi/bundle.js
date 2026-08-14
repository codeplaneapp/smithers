import { SmithersError } from "@smthrs/errors/SmithersError";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const thisDir = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(thisDir, "../../../..");
// Pin BOTH react and react-dom to the copy this server package resolves.
// react-dom hard-requires a version-matched react, so deduping only `react`
// (the old behavior) left react-dom resolving from the consumer workspace and
// crashed with mixed React copies as soon as a UI imported react-dom directly
// (portals, flushSync, createRoot in shared components).
const reactSpecifierRe = /^react(?:-dom)?(?:\/.*)?$/;
const tanstackSpecifierRe = /^@tanstack\//;
const smithersUiSpecifierRe =
  /^(?:smthrs\/gateway-(?:react|client)|@smthrs\/(?:gateway-react|gateway-client|gateway)(?:\/.*)?)$/;
const INLINE_UI_NAMESPACE = "smithers-inline-ui";
/** @type {WeakMap<Map<string, string>, Map<string, Map<string, string>>>} */
const uiCacheInputSnapshots = new WeakMap();

/**
 * Bun's createRequire.resolve can return the original bare specifier when a
 * source-shipping package is reached through a consumer workspace symlink.
 * File-namespace onResolve callbacks may return only absolute paths.
 *
 * @param {string} specifier
 * @param {string[]} searchPaths
 * @returns {string | null}
 */
function resolveAbsoluteFile(specifier, searchPaths) {
  const resolvers = [
    () => require.resolve(specifier, { paths: searchPaths }),
    ...searchPaths.map((searchPath) => () => Bun.resolveSync(specifier, searchPath)),
  ];
  for (const resolveSpecifier of resolvers) {
    try {
      const path = resolveSpecifier();
      if (typeof path === "string" && isAbsolute(path)) {
        return path;
      }
    } catch {}
  }
  return null;
}

function resolveReactPeer(specifier) {
  return resolveAbsoluteFile(specifier, [thisDir, monorepoRoot]);
}

/**
 * @param {string} specifier
 * @param {string | undefined} resolveDir
 * @returns {string | null}
 */
function resolveWorkspaceDependency(specifier, resolveDir) {
  const packageRoots = [
    resolve(monorepoRoot, "packages/gateway-react/src"),
    resolve(monorepoRoot, "packages/gateway-react"),
    resolve(monorepoRoot, "packages/gateway-client/src"),
    resolve(monorepoRoot, "packages/gateway-client"),
    resolve(process.cwd(), "packages/gateway-react/src"),
    resolve(process.cwd(), "packages/gateway-react"),
    resolve(process.cwd(), "packages/gateway-client/src"),
    resolve(process.cwd(), "packages/gateway-client"),
  ];
  const searchPaths = [resolveDir, resolveDir ? dirname(resolveDir) : null, ...packageRoots, process.cwd()].filter(
    Boolean,
  );
  return resolveAbsoluteFile(specifier, searchPaths);
}

/**
 * @param {string} specifier
 * @param {string | undefined} resolveDir
 * @returns {string | null}
 */
function resolveSmithersUiDependency(specifier, resolveDir) {
  return resolveAbsoluteFile(specifier, [resolveDir, monorepoRoot, process.cwd()].filter(Boolean));
}

/**
 * @param {string} source
 * @returns {string}
 */
function moduleSpecifier(source) {
  if (source.startsWith("file://")) {
    return fileURLToPath(source);
  }
  if (source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source)) {
    return source;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)) {
    return source;
  }
  return source;
}

/**
 * @param {unknown} inline
 * @returns {inline is { kind: "literal"; tree: unknown } | { kind: "component"; source: string; exportName?: string }}
 */
function isInlineUi(inline) {
  return Boolean(inline && typeof inline === "object" && "kind" in inline);
}

/**
 * @param {{ inline?: unknown }} config
 * @returns {string | null}
 */
function inlineEntrypoint(config) {
  if (!isInlineUi(config.inline)) {
    return null;
  }
  const digest = createHash("sha1").update(JSON.stringify(config.inline)).digest("hex").slice(0, 16);
  return `smithers-inline-ui:${digest}`;
}

/**
 * @param {{ inline?: unknown }} config
 * @returns {import("bun").BunPlugin | null}
 */
function inlineUiPlugin(config) {
  if (!isInlineUi(config.inline)) {
    return null;
  }
  const contents =
    config.inline.kind === "literal"
      ? renderLiteralInlineUiEntry(config.inline.tree)
      : renderComponentInlineUiEntry(config.inline.source, config.inline.exportName ?? "default");
  return {
    name: "smithers-inline-ui-entry",
    setup(build) {
      build.onResolve({ filter: /^smithers-inline-ui:/ }, (args) => ({
        path: args.path,
        namespace: INLINE_UI_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: INLINE_UI_NAMESPACE }, () => ({
        loader: "tsx",
        contents,
      }));
    },
  };
}

/**
 * @param {unknown} tree
 * @returns {string}
 */
function renderLiteralInlineUiEntry(tree) {
  return [
    'import { createElement } from "react";',
    'import { createRoot } from "react-dom/client";',
    `const tree = ${JSON.stringify(tree)};`,
    "function inflate(node) {",
    "  if (node == null || typeof node === 'string' || typeof node === 'number') return node;",
    "  if (Array.isArray(node)) return node.map(inflate);",
    "  const children = Array.isArray(node.children) ? node.children.map(inflate) : [];",
    "  return createElement(node.type, node.props || null, ...children);",
    "}",
    "function App() { return inflate(tree); }",
    "createRoot(document.getElementById('root')).render(createElement(App));",
  ].join("\n");
}

/**
 * @param {string} source
 * @param {string} exportName
 * @returns {string}
 */
function renderComponentInlineUiEntry(source, exportName) {
  return [
    'import { createElement } from "react";',
    'import { createRoot } from "react-dom/client";',
    `import * as InlineUiModule from ${JSON.stringify(moduleSpecifier(source))};`,
    `const exportName = ${JSON.stringify(exportName)};`,
    "const Component = exportName === 'default' ? InlineUiModule.default : InlineUiModule[exportName];",
    "if (!Component) throw new Error(`Smithers inline UI export not found: ${exportName}`);",
    "function App() {",
    "  const boot = globalThis.__SMITHERS_GATEWAY_UI__ || {};",
    "  return createElement(Component, { ...(boot.props || {}), boot, workflowKey: boot.workflowKey, mountPath: boot.mountPath });",
    "}",
    "createRoot(document.getElementById('root')).render(createElement(App));",
  ].join("\n");
}

/**
 * @returns {boolean}
 */
function noCacheRequested() {
  return (
    !!process.env.SMITHERS_GATEWAY_UI_NO_CACHE &&
    process.env.SMITHERS_GATEWAY_UI_NO_CACHE !== "0" &&
    process.env.SMITHERS_GATEWAY_UI_NO_CACHE !== "false"
  );
}

/**
 * @param {string} input
 * @param {string} buildRoot
 * @returns {string | null}
 */
function buildInputFilePath(input, buildRoot) {
  if (input.startsWith("file://")) {
    return fileURLToPath(input);
  }
  if (isAbsolute(input)) {
    return input;
  }
  // Bun includes virtual plugin namespaces in the metafile alongside real
  // files. They have no filesystem freshness signal; their config-derived
  // entry key already changes when their contents change.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input)) {
    return null;
  }
  return resolve(buildRoot, input);
}

/**
 * @param {import("bun").BuildMetafile | undefined} metafile
 * @param {string} buildRoot
 * @returns {string[]}
 */
function buildInputFiles(metafile, buildRoot) {
  return [
    ...new Set(
      Object.keys(metafile?.inputs ?? {})
        .map((input) => buildInputFilePath(input, buildRoot))
        .filter((input) => input !== null),
    ),
  ];
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function inputFingerprint(file) {
  try {
    const stat = statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return null;
  }
}

/**
 * @param {string[]} files
 * @returns {Map<string, string>}
 */
function snapshotBuildInputs(files) {
  const snapshot = new Map();
  for (const file of files) {
    const fingerprint = inputFingerprint(file);
    if (fingerprint !== null) {
      snapshot.set(file, fingerprint);
    }
  }
  return snapshot;
}

/**
 * @param {Map<string, string>} snapshot
 * @returns {boolean}
 */
function buildInputsAreFresh(snapshot) {
  for (const [file, fingerprint] of snapshot) {
    if (inputFingerprint(file) !== fingerprint) {
      return false;
    }
  }
  return true;
}

/**
 * @param {Record<string, unknown>} config
 * @param {Map<string, string>} cache
 */
export async function bundleGatewayUiEntry(config, cache) {
  // SMITHERS_GATEWAY_UI_NO_CACHE still forces a build on every request. The
  // default cache is dependency-aware: unchanged bundles stay cheap to serve,
  // while editing the entry or any bundled import invalidates it on refresh.
  const noCache = noCacheRequested();
  const inlineEntry = inlineEntrypoint(config);
  const cacheKey = inlineEntry ?? String(config.entry);
  const cached = noCache ? undefined : cache.get(cacheKey);
  if (cached) {
    const inputSnapshot = uiCacheInputSnapshots.get(cache)?.get(cacheKey);
    // Preserve explicitly pre-populated caches that predate input metadata.
    if (!inputSnapshot || buildInputsAreFresh(inputSnapshot)) {
      return cached;
    }
  }
  if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
    throw new SmithersError("INVALID_INPUT", "Gateway UI bundling requires Bun.build.");
  }
  let bundle;
  try {
    bundle = await buildGatewayUiBundleWithInputs(config);
  } catch (inProcessError) {
    // Globally registered Bun runtime plugins leak into every in-process
    // Bun.build call that passes a `plugins` array. The engine's
    // workflow-module-resolution plugin registers virtual modules for bare
    // specifiers ("react", ...), which the bundler then resolves to
    // non-absolute paths and fails. A pristine subprocess has an empty
    // runtime-module registry, so retry there before giving up.
    bundle = await buildGatewayUiBundleInSubprocess(config, inProcessError);
  }
  if (!noCache) {
    cache.set(cacheKey, bundle.body);
    let snapshots = uiCacheInputSnapshots.get(cache);
    if (!snapshots) {
      snapshots = new Map();
      uiCacheInputSnapshots.set(cache, snapshots);
    }
    snapshots.set(cacheKey, snapshotBuildInputs(bundle.inputFiles));
  }
  return bundle.body;
}

/**
 * @param {Record<string, unknown>} config
 * @param {unknown} inProcessError
 * @returns {Promise<{ body: string; inputFiles: string[] }>}
 */
async function buildGatewayUiBundleInSubprocess(config, inProcessError) {
  if (typeof Bun.spawn !== "function") {
    throw inProcessError;
  }
  // cwd is thisDir, not process.cwd(): a bunfig.toml at the caller's cwd may
  // preload modules that poison the fresh registry the same way (the
  // .smithers pack preloads smthrs). The worker chdirs back
  // to the real cwd before building.
  const proc = Bun.spawn([process.execPath, resolve(thisDir, "bundleWorker.js")], {
    cwd: thisDir,
    stdin: new TextEncoder().encode(JSON.stringify({ config, cwd: process.cwd() })),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (exitCode !== 0) {
    // Both builds failed: the entry itself is broken. The in-process error
    // carries the log-derived message callers already rely on.
    throw inProcessError;
  }
  try {
    const separator = stdout.indexOf("\n");
    if (separator === -1) {
      throw new Error("Gateway UI bundle worker omitted its input manifest.");
    }
    const inputFiles = JSON.parse(stdout.slice(0, separator));
    if (!Array.isArray(inputFiles) || inputFiles.some((input) => typeof input !== "string")) {
      throw new Error("Gateway UI bundle worker returned an invalid input manifest.");
    }
    return { body: stdout.slice(separator + 1), inputFiles };
  } catch {
    throw inProcessError;
  }
}

/**
 * @param {Record<string, unknown>} config
 * @param {(inputFiles: string[]) => void} [onBuildInputs]
 * @returns {Promise<string>}
 */
export async function buildGatewayUiBundle(config, onBuildInputs) {
  const bundle = await buildGatewayUiBundleWithInputs(config);
  onBuildInputs?.(bundle.inputFiles);
  return bundle.body;
}

/**
 * @param {Record<string, unknown>} config
 * @returns {Promise<{ body: string; inputFiles: string[] }>}
 */
async function buildGatewayUiBundleWithInputs(config) {
  const noCache = noCacheRequested();
  const inlineEntry = inlineEntrypoint(config);
  const buildRoot = process.cwd();
  const result = await Bun.build({
    entrypoints: [inlineEntry ?? String(config.entry)],
    root: process.cwd(),
    target: "browser",
    format: "esm",
    // Serve production React: the development build plus inline sourcemaps
    // made every UI bundle 3.7-6.6 MB. Sourcemaps stay inline (operators
    // debug against them); minify stays off so stack traces read cleanly.
    define: { "process.env.NODE_ENV": JSON.stringify(noCache ? "development" : "production") },
    sourcemap: "inline",
    metafile: true,
    minify: false,
    jsx: {
      runtime: "automatic",
      importSource: "react",
    },
    plugins: [
      inlineUiPlugin(config),
      {
        name: "smithers-react-peer-dedupe",
        setup(build) {
          build.onResolve({ filter: reactSpecifierRe }, (args) => {
            const path = resolveReactPeer(args.path);
            return path ? { path } : undefined;
          });
          build.onResolve({ filter: tanstackSpecifierRe }, (args) => {
            const path = resolveWorkspaceDependency(args.path, args.resolveDir);
            return path ? { path } : undefined;
          });
          build.onResolve({ filter: smithersUiSpecifierRe }, (args) => {
            const path = resolveSmithersUiDependency(args.path, args.resolveDir);
            return path ? { path } : undefined;
          });
        },
      },
    ].filter(Boolean),
  });
  if (!result.success) {
    const message =
      result.logs
        ?.map((entry) => entry.message)
        .filter(Boolean)
        .join("\n") || `Failed to build Gateway UI entry ${config.entry}`;
    throw new SmithersError("INVALID_INPUT", message);
  }
  const output = result.outputs.find((entry) => entry.path.endsWith(".js")) ?? result.outputs[0];
  return {
    body: await output.text(),
    inputFiles: buildInputFiles(result.metafile, buildRoot),
  };
}

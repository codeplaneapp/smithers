import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// Pin BOTH react and react-dom to the copy this server package resolves.
// react-dom hard-requires a version-matched react, so deduping only `react`
// (the old behavior) left react-dom resolving from the consumer workspace and
// crashed with mixed React copies as soon as a UI imported react-dom directly
// (portals, flushSync, createRoot in shared components).
const reactSpecifierRe = /^react(?:-dom)?(?:\/.*)?$/;
const tanstackSpecifierRe = /^@tanstack\//;
const INLINE_UI_NAMESPACE = "smithers-inline-ui";

function resolveReactPeer(specifier) {
    try {
        return require.resolve(specifier);
    }
    catch {
        return null;
    }
}

/**
 * @param {string} specifier
 * @param {string | undefined} resolveDir
 * @returns {string | null}
 */
function resolveWorkspaceDependency(specifier, resolveDir) {
    try {
        return require.resolve(specifier, {
            paths: [resolveDir, process.cwd()].filter(Boolean),
        });
    }
    catch {
        return null;
    }
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
    const contents = config.inline.kind === "literal"
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
        'import { createGatewayReactRoot } from "@smithers-orchestrator/gateway-react";',
        `import * as InlineUiModule from ${JSON.stringify(moduleSpecifier(source))};`,
        `const exportName = ${JSON.stringify(exportName)};`,
        "const Component = exportName === 'default' ? InlineUiModule.default : InlineUiModule[exportName];",
        "if (!Component) throw new Error(`Smithers inline UI export not found: ${exportName}`);",
        "function App() {",
        "  const boot = globalThis.__SMITHERS_GATEWAY_UI__ || {};",
        "  return createElement(Component, { ...(boot.props || {}), boot, workflowKey: boot.workflowKey, mountPath: boot.mountPath });",
        "}",
        "createGatewayReactRoot(createElement(App), { baseUrl: globalThis.location?.origin });",
    ].join("\n");
}

/**
 * @param {Record<string, unknown>} config
 * @param {Map<string, string>} cache
 */
export async function bundleGatewayUiEntry(config, cache) {
    // Dev mode: SMITHERS_GATEWAY_UI_NO_CACHE rebuilds the UI bundle on every
    // request so edits to the entry OR any of its imported modules show up on a
    // plain page reload — no gateway restart needed. Default (unset) keeps the
    // build-once cache for production serving.
    const noCache = !!process.env.SMITHERS_GATEWAY_UI_NO_CACHE
        && process.env.SMITHERS_GATEWAY_UI_NO_CACHE !== "0"
        && process.env.SMITHERS_GATEWAY_UI_NO_CACHE !== "false";
    const inlineEntry = inlineEntrypoint(config);
    const cacheKey = inlineEntry ?? String(config.entry);
    const cached = noCache ? undefined : cache.get(cacheKey);
    if (cached) {
        return cached;
    }
    if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
        throw new SmithersError("INVALID_INPUT", "Gateway UI bundling requires Bun.build.");
    }
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
                },
            },
        ].filter(Boolean),
    });
    if (!result.success) {
        const message = result.logs?.map((entry) => entry.message).filter(Boolean).join("\n")
            || `Failed to build Gateway UI entry ${config.entry}`;
        throw new SmithersError("INVALID_INPUT", message);
    }
    const output = result.outputs.find((entry) => entry.path.endsWith(".js")) ?? result.outputs[0];
    const body = await output.text();
    if (!noCache) {
        cache.set(cacheKey, body);
    }
    return body;
}

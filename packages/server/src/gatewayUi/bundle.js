import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Pin BOTH react and react-dom to the copy this server package resolves.
// react-dom hard-requires a version-matched react, so deduping only `react`
// (the old behavior) left react-dom resolving from the consumer workspace and
// crashed with mixed React copies as soon as a UI imported react-dom directly
// (portals, flushSync, createRoot in shared components).
const reactSpecifierRe = /^react(?:-dom)?(?:\/.*)?$/;

function resolveReactPeer(specifier) {
    try {
        return require.resolve(specifier);
    }
    catch {
        return null;
    }
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
    const cached = noCache ? undefined : cache.get(String(config.entry));
    if (cached) {
        return cached;
    }
    if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
        throw new SmithersError("INVALID_INPUT", "Gateway UI bundling requires Bun.build.");
    }
    const result = await Bun.build({
        entrypoints: [String(config.entry)],
        root: process.cwd(),
        target: "browser",
        format: "esm",
        sourcemap: "inline",
        minify: false,
        jsx: {
            runtime: "automatic",
            importSource: "react",
        },
        plugins: [
            {
                name: "smithers-react-peer-dedupe",
                setup(build) {
                    build.onResolve({ filter: reactSpecifierRe }, (args) => {
                        const path = resolveReactPeer(args.path);
                        return path ? { path } : undefined;
                    });
                },
            },
        ],
    });
    if (!result.success) {
        const message = result.logs?.map((entry) => entry.message).filter(Boolean).join("\n")
            || `Failed to build Gateway UI entry ${config.entry}`;
        throw new SmithersError("INVALID_INPUT", message);
    }
    const output = result.outputs.find((entry) => entry.path.endsWith(".js")) ?? result.outputs[0];
    const body = await output.text();
    if (!noCache) {
        cache.set(String(config.entry), body);
    }
    return body;
}

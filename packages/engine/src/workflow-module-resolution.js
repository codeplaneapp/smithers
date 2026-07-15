import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const WORKFLOW_MODULE_RESOLUTION = Symbol.for("smithers.workflow-module-resolution");
const require = createRequire(import.meta.url);

/**
 * Resolve a module from the engine installation rather than from a workflow
 * pack. Workflow packs are independently installable, so their copies of React
 * must never be allowed to cross the renderer boundary.
 *
 * @param {string} specifier
 * @param {boolean} [optional]
 * @returns {string | undefined}
 */
function resolveEngineModule(specifier, optional = false) {
    try {
        return require.resolve(specifier);
    }
    catch (error) {
        if (optional && /** @type {{ code?: unknown }} */ (error).code === "MODULE_NOT_FOUND") {
            return undefined;
        }
        throw error;
    }
}

/**
 * Make workflow-facing modules resolve from the active engine installation.
 * Bun's runtime module registry is used instead of onResolve: runtime imports
 * of bare package specifiers do not run onResolve hooks.
 */
export function installWorkflowModuleResolution() {
    const bun = typeof Bun === "undefined" ? undefined : Bun;
    if (!bun?.plugin) {
        return;
    }

    const globals = /** @type {Record<symbol, unknown>} */ (globalThis);
    if (globals[WORKFLOW_MODULE_RESOLUTION]) {
        return;
    }

    /** @type {Map<string, string>} */
    const aliases = new Map([
        ["react", resolveEngineModule("react")],
        ["react/jsx-runtime", resolveEngineModule("react/jsx-runtime")],
        ["react/jsx-dev-runtime", resolveEngineModule("react/jsx-dev-runtime")],
        ["@smithers-orchestrator/components", resolveEngineModule("@smithers-orchestrator/components")],
    ]);
    for (const specifier of ["smithers-orchestrator", "smithers-orchestrator/jsx-runtime", "smithers-orchestrator/jsx-dev-runtime"]) {
        const resolved = resolveEngineModule(specifier, true);
        if (resolved) {
            aliases.set(specifier, resolved);
        }
    }

    // Keep the first engine installation in charge for the lifetime of the
    // process. A later workflow-pack copy must not replace these identities.
    globals[WORKFLOW_MODULE_RESOLUTION] = true;
    bun.plugin({
        name: "smithers-workflow-module-resolution",
        setup(build) {
            for (const [specifier, resolved] of aliases) {
                build.module(specifier, () => {
                    // React is required by CommonJS react-dom internals. Bun
                    // cannot require an async virtual module, so these three
                    // canonical modules must stay synchronous.
                    if (specifier === "react" || specifier.startsWith("react/")) {
                        const module = require(resolved);
                        return { exports: { ...module, default: module.default ?? module }, loader: "object" };
                    }
                    return {
                        // A source-level re-export retains the complete
                        // static export list, including `export *` chains in
                        // smithers-orchestrator, while its absolute target
                        // keeps resolution in the engine installation.
                        contents: `export * from ${JSON.stringify(pathToFileURL(resolved).href)};`,
                        loader: "js",
                    };
                });
            }
        },
    });
}

installWorkflowModuleResolution();

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
  } catch (error) {
    if (optional && /** @type {{ code?: unknown }} */ (error).code === "MODULE_NOT_FOUND") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Make workflow-facing modules resolve from the active engine installation.
 * Resolve bare workflow imports to physical files in the engine installation
 * so ESM imports and CommonJS requires share Bun's normal module cache.
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
    ["@smthrs/components", resolveEngineModule("@smthrs/components")],
  ]);
  for (const specifier of ["smthrs", "smthrs/jsx-runtime", "smthrs/jsx-dev-runtime"]) {
    const resolved = resolveEngineModule(specifier, true);
    if (resolved) {
      aliases.set(specifier, resolved);
    }
  }
  const reactPackagePaths = new Map([
    ["react", "react/index.js"],
    ["react/jsx-runtime", "react/jsx-runtime.js"],
    ["react/jsx-dev-runtime", "react/jsx-dev-runtime.js"],
  ]);
  const eagerReactExports = new Map();
  for (const [specifier, resolved] of aliases) {
    if (reactPackagePaths.has(specifier)) {
      const module = require(resolved);
      eagerReactExports.set(specifier, { ...module, default: module.default ?? module });
    }
  }

  // Keep the first engine installation in charge for the lifetime of the
  // process. A later workflow-pack copy must not replace these identities.
  globals[WORKFLOW_MODULE_RESOLUTION] = true;
  bun.plugin({
    name: "smithers-workflow-module-resolution",
    setup(build) {
      for (const [specifier, resolved] of aliases) {
        const packagePath = reactPackagePaths.get(specifier);
        if (!packagePath) {
          build.module(specifier, () => ({
            contents: `export * from ${JSON.stringify(pathToFileURL(resolved).href)};`,
            loader: "js",
          }));
          continue;
        }
        const escapedPackagePath = packagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("/", "[\\\\/]");
        const exports = eagerReactExports.get(specifier);
        build.onLoad({ filter: new RegExp(`[\\\\/]node_modules[\\\\/]${escapedPackagePath}$`) }, () => ({
          exports,
          loader: "object",
        }));
      }
    },
  });
}

installWorkflowModuleResolution();

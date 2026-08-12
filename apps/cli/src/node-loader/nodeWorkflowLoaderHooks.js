import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveJsxImportSource } from "./resolveJsxImportSource.js";

/**
 * Node ESM hooks that let plain Node run the TypeScript and JSX that Bun
 * transpiles natively: the CLI's own `.ts`/`.tsx` modules, the `.tsx` workflow
 * a user passes to `smithers up`, and `.mdx` workflow files.
 *
 * Node's built-in type stripping is not enough. It refuses `.tsx` outright
 * (ERR_UNKNOWN_FILE_EXTENSION) and refuses every `.ts` under a `node_modules`
 * directory (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is exactly
 * where an installed `smthrs` lives.
 *
 * Both hooks are synchronous because they are installed with
 * `module.registerHooks`. Node loads most of a static import graph on the
 * synchronous path, and that path skips the async `module.register` hooks
 * entirely: an async loader compiles a `.tsx` reached by a top-level dynamic
 * import and then fails on the very same file reached through a static one.
 */
const requireFromHooks = createRequire(import.meta.url);

/** @type {typeof import("esbuild") | undefined} */
let esbuild;
function loadEsbuild() {
  return (esbuild ??= requireFromHooks("esbuild"));
}

/** @type {{ compileSync: (value: unknown, options: unknown) => { value: string } } | undefined} */
let mdxCompiler;
function loadMdxCompiler() {
  return (mdxCompiler ??= requireFromHooks("@mdx-js/mdx"));
}

/** Source extensions esbuild transforms, mapped to its loader name. */
const TRANSFORMED = new Map([
  [".ts", "ts"],
  [".mts", "ts"],
  [".cts", "ts"],
  [".tsx", "tsx"],
  [".jsx", "jsx"],
]);

/**
 * Extensions tried when a relative specifier does not resolve as written.
 * Bun resolves both `./util/logger` and the TypeScript-style `./logger.js`
 * that points at `logger.ts`; Node resolves neither.
 */
const RESOLVE_CANDIDATES = [".ts", ".tsx", ".mts", ".cts", ".jsx", ".js", ".mjs", ".cjs"];
const INDEX_CANDIDATES = RESOLVE_CANDIDATES.map((extension) => `/index${extension}`);

/**
 * @param {string} specifier
 * @param {string | undefined} parentURL
 * @returns {string | undefined}
 */
function findSourceSibling(specifier, parentURL) {
  if (!parentURL?.startsWith("file:")) return undefined;
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const withoutExtension = specifier.replace(/\.(js|mjs|cjs|jsx)$/, "");
  for (const candidate of [...RESOLVE_CANDIDATES, ...INDEX_CANDIDATES]) {
    try {
      const url = new URL(withoutExtension + candidate, parentURL);
      if (existsSync(fileURLToPath(url))) return url.href;
    } catch {
      // A specifier that will not form a URL is not ours to rescue.
    }
  }
  return undefined;
}

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(specifier: string, context: unknown) => { url: string }} nextResolve
 */
export function resolve(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    const sibling = findSourceSibling(specifier, context.parentURL);
    if (!sibling) throw error;
    return { url: sibling, format: "module", shortCircuit: true };
  }
}

/**
 * @param {string} url
 * @param {unknown} context
 * @param {(url: string, context: unknown) => unknown} nextLoad
 */
export function load(url, context, nextLoad) {
  if (!url.startsWith("file:")) return nextLoad(url, context);
  const path = fileURLToPath(url.split("?")[0]);
  const extension = extname(path);
  if (extension === ".mdx") {
    const compiled = loadMdxCompiler().compileSync(readFileSync(path), {
      jsxImportSource: resolveJsxImportSource(dirname(path)),
      development: false,
    });
    return { format: "module", source: String(compiled.value), shortCircuit: true };
  }
  const loader = TRANSFORMED.get(extension);
  if (!loader) return nextLoad(url, context);
  const { code } = loadEsbuild().transformSync(readFileSync(path, "utf8"), {
    loader,
    format: "esm",
    target: "esnext",
    // `jsx: "automatic"` is required even when the file carries a
    // `@jsxImportSource` pragma: esbuild reads the pragma for the import
    // source but stays on the classic runtime unless this option flips it.
    jsx: "automatic",
    jsxImportSource: resolveJsxImportSource(dirname(path)),
    sourcemap: "inline",
    sourcefile: path,
  });
  return { format: "module", source: code, shortCircuit: true };
}

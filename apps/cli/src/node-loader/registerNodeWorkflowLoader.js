import { createRequire } from "node:module";
import { load, resolve } from "./nodeWorkflowLoaderHooks.js";

const requireFromHere = createRequire(import.meta.url);

let registered = false;

/**
 * Install the esbuild-backed module hooks that let plain Node import the
 * TypeScript, JSX, and MDX that Bun transpiles natively.
 *
 * Call this before importing the CLI or a workflow file. Under Bun it is a
 * no-op: Bun already transpiles those files.
 *
 * `registerHooks` (in-thread, synchronous) is deliberate. Node loads most of a
 * static import graph on its synchronous path, which skips the off-thread
 * `module.register` hooks, so an async loader compiles a dynamically imported
 * `.tsx` and then fails on the same file reached through a static import.
 * It is read off `node:module` at call time because Bun's `node:module` does
 * not export it and a static import would break this module under Bun.
 *
 * @returns {boolean} whether hooks are installed after this call
 */
export function registerNodeWorkflowLoader() {
  if (typeof Bun !== "undefined") return false;
  if (registered) return true;
  const { registerHooks } = requireFromHere("node:module");
  if (typeof registerHooks !== "function") {
    throw new Error(
      `Running Smithers on Node needs module.registerHooks, added in Node 22.15. This is Node ${process.versions.node}. ` +
        "Upgrade Node, or run Smithers under Bun.",
    );
  }
  registerHooks({ resolve, load });
  registered = true;
  return true;
}

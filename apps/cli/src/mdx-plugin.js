import mdx from "@mdx-js/esbuild";

/**
 * Teach the runtime module loader to compile `.mdx` workflow files on import.
 *
 * `Bun.plugin` is a Bun built-in with no Node equivalent, and a static
 * `import { plugin } from "bun"` would break the CLI under Node. Read it off
 * the global instead, and no-op on Node: `registerNodeWorkflowLoader` installs
 * an esbuild-based module loader there, which handles `.mdx` itself.
 */
export function mdxPlugin() {
  if (typeof Bun === "undefined") return;
  Bun.plugin(mdx());
}

import react from "@vitejs/plugin-react"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import type { Plugin } from "vite"
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite"

/*
 * Every vite invocation in package.json passes `--configLoader runner`. The
 * app graph reaches `smithers-shared`, a workspace package that ships
 * TypeScript source; the default `bundle` loader hands bare specifiers to
 * node's ESM loader, which cannot resolve that package's extensionless
 * relative imports. The runner loader resolves the config through Vite
 * itself, so the workspace source loads the same way it does in the app graph.
 */

/*
 * Resolved against this file, not the shell's working directory: `vite
 * --config apps/ui/vite.config.ts` from the repository root used to serve 404s
 * because a bare "src/mainview" resolved under the root instead. Every path
 * below is absolute for the same reason.
 */
export const here = fileURLToPath(new URL(".", import.meta.url))

/*
 * CN-1: the build stamp. The built SPA is the artifact that goes stale, so it
 * must be able to state which commit it was built from. The stamp is written
 * by the build and travels inside the bundle: a meta tag on the served HTML
 * and a `__build.json` asset next to the hashed chunks.
 *
 * SMITHERS_BUILD_SHA wins so a release script stamps the sha it records;
 * GITHUB_SHA covers a CI build; otherwise the local checkout is asked. A tree
 * with no git answers "unknown".
 */
const BUILD_STAMP_ASSET = "__build.json"
const BUILD_STAMP_META = "smithers-build-sha"

export const resolveBuildSha = (): string => {
  const fromEnv = process.env.SMITHERS_BUILD_SHA ?? process.env.GITHUB_SHA
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim()
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim()
  } catch {
    return "unknown"
  }
}

export const buildStamp = (): Plugin => {
  const gitSha = resolveBuildSha()
  const builtAt = new Date().toISOString()
  return {
    name: "smithers-build-stamp",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { name: BUILD_STAMP_META, content: gitSha }, injectTo: "head" as const },
      { tag: "meta", attrs: { name: "smithers-build-at", content: builtAt }, injectTo: "head" as const }
    ],
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: BUILD_STAMP_ASSET,
        source: `${JSON.stringify({ worker: "smithers-local-app", gitSha, builtAt }, null, "\t")}\n`
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), buildStamp()],
  resolve: {
    /*
     * Electrobun 2.x ships no SDK in node_modules; Hutch projects it into
     * .hutch/devkit (`electrobun prepare`, run implicitly by `electrobun dev`
     * and `electrobun build`). The SPA imports `electrobun/view`, so Vite
     * needs the same aliases Hutch injects into its own bundles.
     */
    alias: electrobunViteAliases(resolve(here, ".hutch/devkit"))
  },
  /*
   * The world editor's Milkdown adapter pulls in Vue's esm-bundler build,
   * which warns on every load that these compile-time flags were never
   * injected. These are the values Vue's own docs name for a bundled app.
   */
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false"
  },
  root: `${here}src/mainview`,
  build: {
    outDir: `${here}dist`,
    emptyOutDir: true
  }
})

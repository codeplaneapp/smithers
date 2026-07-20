import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  dts: { only: true, resolve: false },
  outDir: "src",
  // Remove the previous `index.d.ts` before regenerating. Without this the dts
  // rollup resolves the stale on-disk declaration for the package's own entry
  // and silently emits it unchanged — which is how the sync-layer exports went
  // missing from the published types. Glob is relative to `outDir` (`src`), so
  // only the generated declaration is cleaned; the `.ts` sources are untouched.
  clean: ["index.d.ts"],
  format: ["esm"],
  silent: true,
});

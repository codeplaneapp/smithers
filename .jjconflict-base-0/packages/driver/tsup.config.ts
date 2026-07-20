import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.js" },
  dts: { only: true, resolve: false },
  outDir: "src",
  // Remove the previous `index.d.ts` before regenerating. Without this the dts
  // rollup resolves the stale on-disk declaration for the package's own entry
  // and silently re-emits it unchanged (e.g. it would drop the generic
  // output()/outputMaybe()/latest() overloads). Glob is relative to `outDir`
  // (`src`), so only the generated declaration is cleaned; `.js`/`.ts` sources
  // are untouched.
  clean: ["index.d.ts"],
  format: ["esm"],
  silent: true,
});

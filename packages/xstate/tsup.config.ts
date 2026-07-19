import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.js" },
  dts: { only: true, resolve: false },
  outDir: "src",
  // Remove the previous `index.d.ts` before regenerating so the dts rollup
  // never resolves the stale on-disk declaration for the package's own entry
  // (same trap as packages/driver — see its tsup.config.ts).
  clean: ["index.d.ts"],
  format: ["esm"],
  silent: true,
});

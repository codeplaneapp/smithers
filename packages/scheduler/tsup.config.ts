import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.js" },
  dts: { only: true, resolve: false },
  outDir: "src",
  // Remove the previous `index.d.ts` before regenerating: with `clean: false`
  // the dts rollup resolves the stale on-disk declaration for the package's own
  // entry and silently re-emits it unchanged (same trap packages/driver
  // documents), which makes `check:dts` false-green on type changes.
  clean: ["index.d.ts"],
  format: ["esm"],
  silent: true,
});

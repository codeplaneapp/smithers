import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.js",
    // Emit real types for the ./metrics subpath (its exports map used to
    // point at the top-level index.d.ts, which silently went stale).
    "metrics/index": "src/metrics/index.js",
  },
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
  format: ["esm"],
  // NOTE: multi-entry dts rollup emits a shared, content-hashed chunk
  // (src/<name>-<hash>.d.ts). rollup-plugin-dts is non-deterministic for large
  // declaration files, so the hash and index.d.ts import specifier can change
  // across rebuilds even for identical source (see scripts/publish.mjs drift
  // guard). The build script rm's src/*-*.d.ts first so a renamed chunk never
  // leaves an orphan, and index.d.ts + its chunk are always regenerated together.
  silent: true,
});

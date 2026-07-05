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
  // (src/<name>-<hash>.d.ts). The hash is deterministic for identical content;
  // the build script rm's src/*-*.d.ts first so stale chunks never linger.
  silent: true,
});

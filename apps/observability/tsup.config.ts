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
  silent: true,
});

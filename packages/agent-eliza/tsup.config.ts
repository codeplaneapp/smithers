import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.js", "conventions/index": "src/conventions/index.ts" },
  dts: { only: true, resolve: true },
  outDir: "src",
  clean: false,
  format: ["esm"],
  silent: false,
});

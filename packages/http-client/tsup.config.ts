import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.js", node: "src/node.js" },
  dts: { only: true, resolve: true },
  outDir: "src",
  format: ["esm"],
  sourcemap: false,
  clean: false,
});

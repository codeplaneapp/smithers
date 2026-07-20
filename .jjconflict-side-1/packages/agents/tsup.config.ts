import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.js", "BaseCliAgent/index": "src/BaseCliAgent/index.js" },
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
  format: ["esm"],
  silent: true,
});

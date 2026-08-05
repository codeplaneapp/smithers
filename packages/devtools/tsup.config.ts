import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.js" },
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: ["index.d.ts"],
  format: ["esm"],
  silent: true,
});

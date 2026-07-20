import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.js"],
  dts: true,
  format: ["esm"],
  sourcemap: false,
  clean: true,
});

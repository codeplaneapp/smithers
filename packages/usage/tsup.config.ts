import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/publicTypes.ts" },
  tsconfig: "tsconfig.types.json",
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
  format: ["esm"],
  silent: false,
});

import { defineConfig } from "tsup";

// Source-shipping package: consumers import `src/*.ts` directly. Build the
// declaration bundle used by downstream package typechecks and release packs.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: ["index.d.ts"],
  outDir: "dist",
});

import { defineConfig } from "tsup";

// Source-shipping package: consumers import `src/*.ts(x)` directly (the package
// `exports` point at source). The only build artifact is the `.d.ts` bundle, so
// downstream typecheck has a declaration entry. Mirrors gateway-react.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: ["index.d.ts"],
  outDir: "dist",
});

import { defineConfig } from "tsup";

export default defineConfig({
  // `browser.d.ts` is hand-authored (not generated): see `src/browser.d.ts`
  // and `packages/engine/tsup.config.ts` for why.
  entry: { index: "src/index.js" },
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
  format: ["esm"],
  silent: true,
});

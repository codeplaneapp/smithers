import { defineConfig } from "tsup";

export default defineConfig({
  // `browser.d.ts` is hand-authored (not generated): see `src/browser.d.ts`
  // and `packages/engine/tsup.config.ts` for why.
  // The declaration entry overlays generic component types that JSDoc export
  // harvesting otherwise instantiates as `any`.
  entry: { index: "src/indexDeclarations.ts" },
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
  format: ["esm"],
  silent: true,
});

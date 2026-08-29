import { defineConfig } from "tsup";
// @ts-expect-error — plain .mjs helper shared across package tsup configs; no d.ts.
import { declarationEntries } from "../../scripts/declaration-entries.mjs";

// One declaration file per source module so `@smthrs/integrations/<subpath>`
// ships real types (the package.json `"./*"` exports point each subpath at its own
// .d.ts). Type twins are named `<name>Types.ts` so they never collide with the
// same-basename runtime `.js` in declaration output — declarationEntries() throws
// if that invariant is ever violated.
export default defineConfig({
  entry: declarationEntries(),
  // Pin ESM so declaration output is deterministic `.d.ts` (not `.d.cts`).
  format: ["esm"],
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
});

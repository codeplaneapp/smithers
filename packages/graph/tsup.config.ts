import { defineConfig } from "tsup";
// @ts-expect-error — plain .mjs helper shared across package tsup configs; no d.ts.
import { declarationEntries } from "../../scripts/declaration-entries.mjs";

export default defineConfig({
  entry: declarationEntries(),
  // Pin ESM so declaration output is deterministic `.d.ts` (not `.d.cts`), which
  // the committed per-file declarations and the freshness gate both depend on.
  format: ["esm"],
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
});

import { defineConfig } from "tsup";

export default defineConfig({
  // `browser.d.ts` is hand-authored (not generated): tsup's dts rollup drops
  // exports whose types it cannot fully resolve with `resolve: false` (e.g.
  // Task/Workflow/Sequence/Worktree, re-exported from `@smithers-orchestrator/components`),
  // silently producing an incomplete declaration. See `src/browser.d.ts`.
  entry: { index: "src/index.js" },
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
  format: ["esm"],
  silent: true,
});

import { defineConfig } from "tsup";

// Compile the `.ts` sources to committed `.js` + `.d.ts` in `src/` so the
// published package (and the `smithers-orchestrator/testing` re-export) ships
// runnable JavaScript instead of raw TypeScript that Node cannot load. Pin ESM
// so declaration output is deterministic `.d.ts` (not `.d.cts`).
export default defineConfig({
  entry: {
    index: "src/index.ts",
    fakeAgent: "src/fakeAgent.ts",
    renderWorkflow: "src/renderWorkflow.ts",
    renderPrompt: "src/renderPrompt.ts",
    runTask: "src/runTask.ts",
    simulate: "src/simulate.ts",
    matchers: "src/matchers.ts",
    browser: "src/browser.ts",
  },
  format: ["esm"],
  dts: {
    resolve: false,
    banner: '/// <reference path="../types/bun-test-shim.d.ts" />',
  },
  outDir: "src",
  clean: false,
  splitting: false,
  silent: true,
});

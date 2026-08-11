import { defineConfig } from "tsup";

// Compile the `.ts` sources to committed `.js` + `.d.ts` in `src/` so the
// published package (and the `smthrs/testing` re-export) ships
// runnable JavaScript instead of raw TypeScript that Node cannot load. Pin ESM
// so declaration output is deterministic `.d.ts` (not `.d.cts`).
export default defineConfig({
  entry: {
    index: "src/index.ts",
    fakeAgent: "src/fakeAgent.ts",
    renderWorkflow: "src/renderWorkflow.ts",
    renderPrompt: "src/renderPrompt.ts",
    runTask: "src/runTask.ts",
    // Pre-existing published subpaths — keep building these so `@smthrs/testing/{simulate,matchers,browser,runtimeConformance}`
    // ship regenerated `.js` + `.d.ts` (real consumers in e2e/browser + e2e/runtime).
    simulate: "src/simulate.ts",
    coverWorkflow: "src/coverWorkflow.ts",
    matchers: "src/matchers.ts",
    browser: "src/browser.ts",
    runtimeConformance: "src/runtimeConformance.ts",
    agentTraceVector: "src/agentTraceVector.ts",
    virtualClock: "src/virtualClock.ts",
    scriptedAgent: "src/scriptedAgent.ts",
    runScenario: "src/runScenario.ts",
    runWorkflowScenario: "src/runWorkflowScenario.ts",
    scenarioAssert: "src/scenarioAssert.ts",
    runEffect: "src/runEffect.ts",
    herdrBridge: "src/herdrBridge.ts",
    campaign: "src/campaign.ts",
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
  external: [
    "effect",
    "zod",
    "react",
    "smthrs",
    /^@smthrs\//,
    /^node:/,
  ],
});

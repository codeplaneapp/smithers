/** @jsxImportSource smithers-orchestrator */
// authoring-workflow-creation — the "did the agent actually build it?" suite.
//
// This is the LLM-tier counterpart to apps/cli/tests/workflow-create.e2e.test.js.
// Each case asks a weak model to CREATE a Smithers workflow and verifies the
// artifact renders via `smithers graph` (verify.kind: "graph"). A model that
// narrates how-to prose, stops at a plan, or emits a code block that doesn't
// load fails the graph render — which is exactly the failure this whole change
// set is hardening against (agents describing a workflow instead of writing a
// runnable one). Run it with: bun evals/harness/run-suite.ts authoring-workflow-creation
import { createFluencyEval } from "../../lib/eval-kit";

export default createFluencyEval({ suite: "authoring-workflow-creation" });

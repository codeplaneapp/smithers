/** @jsxImportSource smthrs */
// authoring-workflow-creation — the "did the agent actually build it?" suite.
//
// This is the LLM-tier counterpart to apps/cli/tests/workflow-create.e2e.test.js.
// Each case asks a weak model to CREATE a Smithers workflow and verifies the
// change set contains the workflow, its substantive renderWorkflow-based test,
// and explicit .smithers/package.json registration (verify.kind:
// "workflow-files"). The deterministic scorer renders the graph and runs the
// test; narration, workflow-only output, hollow truthiness tests, and
// unregistered tests all fail. Run it with:
// bun evals/harness/run-suite.ts authoring-workflow-creation
import { createFluencyEval } from "../../lib/eval-kit";

export default createFluencyEval({ suite: "authoring-workflow-creation" });

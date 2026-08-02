/** @jsxImportSource smthrs */
// ui-functional — can a weak model author a custom workflow UI that ACTUALLY
// WORKS? Unlike ui-authoring (which only transpiles the bundle + string-checks
// the API), this suite BOOTS the candidate's UI in a real browser against a real
// run (the ui-eval-fixture) and asserts observed behavior: it mounts, shows live
// status, streams events from every task, renders node output, surfaces the
// FAILED node, and drives a working approval. The `ui-functional` verifier
// (evals/lib/ui-functional-runner.ts) is the hard gate; the ui-quality judge
// grades polish against what actually rendered.
import { createFluencyEval } from "../../lib/eval-kit";

export default createFluencyEval({ suite: "ui-functional" });

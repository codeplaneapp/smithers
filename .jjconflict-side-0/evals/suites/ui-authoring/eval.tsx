/** @jsxImportSource smithers-orchestrator */
// ui-authoring — can a weak model one-shot a custom workflow UI bundle? The
// candidate writes a single .tsx using smithers-orchestrator/gateway-react; the
// `build` verifier transpiles it + checks the right API is used; the ui-quality
// llmJudge scorer (attached automatically for build cases) grades design/UX.
import { createFluencyEval } from "../../lib/eval-kit";

export default createFluencyEval({ suite: "ui-authoring" });

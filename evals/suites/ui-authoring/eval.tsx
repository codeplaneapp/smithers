/** @jsxImportSource smthrs */
// ui-authoring — can a weak model build a custom workflow UI bundle first-try? The
// candidate writes a single .tsx using smthrs/gateway-react; the
// `build` verifier transpiles it + checks the right API is used; the ui-quality
// llmJudge scorer (attached automatically for build cases) grades design/UX.
import { createFluencyEval } from "../../lib/eval-kit";

export default createFluencyEval({ suite: "ui-authoring" });

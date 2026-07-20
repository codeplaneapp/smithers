/** @jsxImportSource smithers-orchestrator */
// ops-runs — can a weak model investigate real run history? The candidate writes
// SQL against Smithers' REAL _smithers_* run schema to answer operational
// questions (which run is blocked? which node failed? what's the error?). The
// `query` verifier runs the candidate's SQL against a deterministic fixture.
import { createFluencyEval } from "../../lib/eval-kit";
import { buildOpsFixture } from "../../lib/fixture.js";

buildOpsFixture();

export default createFluencyEval({ suite: "ops-runs" });

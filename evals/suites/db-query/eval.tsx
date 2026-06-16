/** @jsxImportSource smithers-orchestrator */
// db-query — can a weak model answer questions about a Smithers run DB by writing
// SQL? The candidate gets the schema + path, writes a query; the `query` verifier
// runs THAT query against the seeded fixture and checks the scalar answer.
import { createFluencyEval } from "../../lib/eval-kit";
import { buildFixture } from "../../lib/fixture.js";

// Ensure the deterministic fixture exists before any case runs.
buildFixture();

export default createFluencyEval({ suite: "db-query" });

// Backs the package's `./schema` subpath export (see package.json): re-exports the
// _smithers_scorers drizzle table so consumers get the table definition without importing
// @smithers-orchestrator/db/internal-schema directly (__type-tests__/smithersScorers.test-d.ts
// pins its inferred types).
export { smithersScorers } from "@smithers-orchestrator/db/internal-schema";

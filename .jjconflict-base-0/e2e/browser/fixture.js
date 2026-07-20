import { runSharedRuntimeFixture } from "../runtime/fixture.js";
import { assertRuntimeConformance } from "@smithers-orchestrator/testing/runtimeConformance";

// Cast once: proving Node/Bun globals are *absent* means reading properties
// that this lane's types deliberately don't declare on `globalThis`.
const globalThisRecord = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));

const proof = await runSharedRuntimeFixture({
  globals: { process: typeof globalThisRecord.process, Bun: typeof globalThisRecord.Bun, Buffer: typeof globalThisRecord.Buffer },
});
assertRuntimeConformance(proof, "Browser");
const runIdLooksLikeUuid = proof.runIds.every((runId) => /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId));
globalThisRecord.__smithersBrowserResult = { ...proof, runIdLooksLikeUuid };

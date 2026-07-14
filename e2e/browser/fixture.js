import { runSharedRuntimeFixture } from "../runtime/fixture.js";
import { assertRuntimeConformance } from "@smithers-orchestrator/testing/runtimeConformance";

const proof = await runSharedRuntimeFixture({
  globals: { process: typeof globalThis.process, Bun: typeof globalThis.Bun, Buffer: typeof globalThis.Buffer },
});
assertRuntimeConformance(proof, "Browser");
globalThis.__smithersBrowserResult = { ...proof, runIdLooksLikeUuid: true };

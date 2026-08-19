import { PARITY_FIXTURES, getParityFixture } from "./fixtures/index.ts";
import { getParityEngine } from "./engines/registry.ts";
import { runParityFixture } from "./runParityFixture.ts";
import { writeOracle } from "./oracleStore.ts";

/**
 * Record the fixture oracles.
 *
 *   bun e2e/parity/recordOracles.ts                # every fixture
 *   bun e2e/parity/recordOracles.ts linear-sequence retry-then-succeed
 *
 * The oracle is always recorded on the legacy engine: it is the reference
 * implementation that the flows engine has to reproduce, and re-recording it
 * from a candidate engine would make the suite tautological. Re-record only
 * when a legacy behaviour change is intended, and review the diff.
 */

const requested = process.argv.slice(2);
const fixtures = requested.length > 0 ? requested.map(getParityFixture) : PARITY_FIXTURES;
const engine = getParityEngine("legacy");

let failures = 0;
for (const fixture of fixtures) {
  try {
    const { observation, cleanup } = await runParityFixture(fixture, engine);
    try {
      writeOracle(fixture.id, observation);
      process.stdout.write(`recorded ${fixture.id} (${observation.verdict.status})\n`);
    } finally {
      cleanup();
    }
  } catch (error) {
    failures += 1;
    process.stderr.write(
      `FAILED ${fixture.id}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  }
}

const { closeSingleRunnerRuntime } = await import("smthrs");
await closeSingleRunnerRuntime();
process.exitCode = failures === 0 ? 0 : 1;

import { afterAll, describe, expect, test } from "bun:test";
import { closeSingleRunnerRuntime } from "smthrs";
import { selectParityEngines } from "./engines/registry.ts";
import { PARITY_FIXTURES } from "./fixtures/index.ts";
import { diffObservations, formatParityDifferences } from "./observation/compareObservations.ts";
import type { ParityObservation } from "./ParityObservation.ts";
import { hasOracle, readOracle } from "./oracleStore.ts";
import { runParityFixture } from "./runParityFixture.ts";

/**
 * Cross-engine conformance suite (stage 0.5 of the flows migration).
 *
 * Every fixture runs on every selected engine against a real on-disk
 * database, and the durable state it leaves behind is compared against the
 * committed oracle: node states, attempt traces, output rows, the event
 * projection, and the terminal verdict. When more than one engine is
 * selected the engines are also compared against each other, which is the
 * shape the suite takes from stage 1.3 on.
 *
 * No lane of stages 1 to 3 is accepted while this suite is red.
 */

const FIXTURE_TIMEOUT_MS = 120_000;
const selection = selectParityEngines();

afterAll(async () => {
  // The engine leaves the process-local SingleRunner cluster runtime alive
  // after a run settles; without this the test process would not exit.
  await closeSingleRunnerRuntime();
});

describe("parity harness", () => {
  test("at least one engine is available and every fixture has a committed oracle", () => {
    expect(selection.engines.length).toBeGreaterThan(0);
    const missing = PARITY_FIXTURES.filter((fixture) => !hasOracle(fixture.id)).map(
      (fixture) => fixture.id,
    );
    expect(
      missing,
      `fixtures without a committed oracle: ${missing.join(", ")}. ` +
        `Record with: bun e2e/parity/recordOracles.ts`,
    ).toEqual([]);
  });

  test("fixture ids are unique", () => {
    const ids = PARITY_FIXTURES.map((fixture) => fixture.id);
    expect([...new Set(ids)].sort()).toEqual([...ids].sort());
  });
});

for (const fixture of PARITY_FIXTURES) {
  describe(`parity fixture ${fixture.id}`, () => {
    const observations = new Map<string, ParityObservation>();

    for (const engine of selection.engines) {
      test(
        `${engine.id}: ${fixture.title}`,
        async () => {
          const { observation, cleanup } = await runParityFixture(fixture, engine);
          try {
            observations.set(engine.id, observation);
            const oracle = readOracle(fixture.id);
            const differences = diffObservations(oracle, observation);
            expect(
              differences.length === 0,
              formatParityDifferences(differences, "oracle", engine.id),
            ).toBe(true);
          } finally {
            cleanup();
          }
        },
        fixture.timeoutMs ?? FIXTURE_TIMEOUT_MS,
      );
    }

    // With one engine selected this is vacuous by construction; it becomes
    // the load-bearing assertion once stage 1.3 registers the flows engine.
    test("every selected engine produced the same observation", () => {
      const entries = [...observations.entries()];
      if (entries.length < 2) return;
      const [referenceId, reference] = entries[0]!;
      for (const [engineId, observation] of entries.slice(1)) {
        const differences = diffObservations(reference, observation);
        expect(
          differences.length === 0,
          formatParityDifferences(differences, referenceId, engineId),
        ).toBe(true);
      }
    });
  });
}

describe("parity engine selection", () => {
  test("records why a registered engine was skipped", () => {
    for (const skipped of selection.skipped) {
      expect(skipped.reason.length).toBeGreaterThan(0);
    }
  });
});

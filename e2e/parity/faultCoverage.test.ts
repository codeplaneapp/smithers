import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PARITY_FIXTURES } from "./fixtures/index.ts";
import coverage from "./fault-coverage.json" with { type: "json" };

/**
 * The parity suite has to account for every case in the fault matrix: either a
 * fixture carries the case's engine-observable behaviour, or the case is
 * marked out of scope with a reason. Nothing may be left unclassified, so a
 * new fault case cannot land without a decision about whether the parity
 * suite covers it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

type FaultMatrix = { cases: { id: string; file: string; promotionTier: string }[] };
type CoverageEntry = { status: string; fixtures: string[]; reason: string };

const matrix = JSON.parse(
  readFileSync(join(HERE, "..", "fault-matrix.json"), "utf8"),
) as FaultMatrix;
const entries = coverage.cases as Record<string, CoverageEntry>;
const fixtureIds = new Set(PARITY_FIXTURES.map((fixture) => fixture.id));

describe("parity fault-case coverage", () => {
  test("every fault-matrix case is classified", () => {
    const missing = matrix.cases.map((entry) => entry.id).filter((id) => !(id in entries));
    expect(missing, `fault cases with no entry in fault-coverage.json: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  test("no coverage entry names a case the fault matrix does not have", () => {
    const known = new Set(matrix.cases.map((entry) => entry.id));
    const extra = Object.keys(entries).filter((id) => !known.has(id));
    expect(extra, `fault-coverage.json entries with no matrix case: ${extra.join(", ")}`).toEqual([]);
  });

  test("every entry carries a status and a reason", () => {
    for (const [id, entry] of Object.entries(entries)) {
      expect(["ported", "out-of-scope"], `${id} has an unknown status`).toContain(entry.status);
      expect(entry.reason.length, `${id} has no reason`).toBeGreaterThan(20);
    }
  });

  test("a ported case names at least one existing fixture", () => {
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.status !== "ported") continue;
      expect(entry.fixtures.length, `${id} is ported but names no fixture`).toBeGreaterThan(0);
      for (const fixtureId of entry.fixtures) {
        expect(fixtureIds.has(fixtureId), `${id} names unknown fixture ${fixtureId}`).toBe(true);
      }
    }
  });

  test("an out-of-scope case names no fixture", () => {
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.status === "ported") continue;
      expect(entry.fixtures, `${id} is out of scope but names fixtures`).toEqual([]);
    }
  });

  test("a fixture's portsFaultCases and the coverage map agree", () => {
    for (const fixture of PARITY_FIXTURES) {
      for (const caseId of fixture.portsFaultCases) {
        const entry = entries[caseId];
        expect(entry, `fixture ${fixture.id} claims unknown case ${caseId}`).toBeDefined();
        expect(entry?.status, `fixture ${fixture.id} claims ${caseId}, which is not marked ported`).toBe(
          "ported",
        );
        expect(
          entry?.fixtures.includes(fixture.id),
          `${caseId} does not list fixture ${fixture.id}`,
        ).toBe(true);
      }
    }
    for (const [caseId, entry] of Object.entries(entries)) {
      if (entry.status !== "ported") continue;
      for (const fixtureId of entry.fixtures) {
        const fixture = PARITY_FIXTURES.find((candidate) => candidate.id === fixtureId);
        expect(
          fixture?.portsFaultCases.includes(caseId),
          `fixture ${fixtureId} does not declare ${caseId} in portsFaultCases`,
        ).toBe(true);
      }
    }
  });
});

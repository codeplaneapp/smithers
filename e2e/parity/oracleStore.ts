import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParityObservation } from "./ParityObservation.ts";

/**
 * The committed fixture oracle.
 *
 * Stage 0.5 records the legacy engine's observation for every fixture and
 * commits it. From then on the oracle, not the legacy engine, is the
 * reference: a legacy-engine change that alters durable behaviour shows up as
 * an oracle diff, and stage 1.3 onward the flows engine is compared against
 * the same file. The oracle is the reason the suite can gate a lane that has
 * deleted the legacy loop entirely.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const ORACLE_DIR = join(HERE, "oracles");

export function oraclePath(fixtureId: string): string {
  return join(ORACLE_DIR, `${fixtureId}.json`);
}

export function hasOracle(fixtureId: string): boolean {
  return existsSync(oraclePath(fixtureId));
}

export function readOracle(fixtureId: string): ParityObservation {
  const path = oraclePath(fixtureId);
  if (!existsSync(path)) {
    throw new Error(
      `parity: no committed oracle for fixture ${fixtureId}. ` +
        `Record it with: bun e2e/parity/recordOracles.ts ${fixtureId}`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as ParityObservation;
}

export function writeOracle(fixtureId: string, observation: ParityObservation): void {
  mkdirSync(ORACLE_DIR, { recursive: true });
  writeFileSync(oraclePath(fixtureId), `${JSON.stringify(observation, null, 2)}\n`);
}

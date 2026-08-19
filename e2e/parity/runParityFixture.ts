import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParityEngine } from "./engines/ParityEngine.ts";
import type { ParityFixture } from "./ParityFixture.ts";
import type { ParityObservation } from "./ParityObservation.ts";

/**
 * Run one fixture on one engine in a throwaway workspace and return the
 * normalized observation.
 *
 * Every execution gets its own directory and its own on-disk database, so the
 * same fixture can run on two engines concurrently without either seeing the
 * other's state.
 */
export async function runParityFixture(
  fixture: ParityFixture,
  engine: ParityEngine,
): Promise<{ observation: ParityObservation; cleanup: () => void }> {
  const scratchDir = mkdtempSync(join(tmpdir(), `smithers-parity-${fixture.id}-${engine.id}-`));
  const dbPath = join(scratchDir, "parity.db");
  const runId = `parity-${fixture.id}-${engine.id}`;
  const cleanup = () => {
    rmSync(scratchDir, { recursive: true, force: true });
  };
  try {
    const observation = await engine.execute(fixture, { runId, dbPath, scratchDir });
    return { observation, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

import { isParityEngineId, type ParityEngineId } from "../ParityEngineId.ts";
import type { ParityEngine } from "./ParityEngine.ts";
import { flowsEngine } from "./flowsEngine.ts";
import { legacyEngine } from "./legacyEngine.ts";

/**
 * The engine selector.
 *
 * `SMITHERS_PARITY_ENGINES` picks engines explicitly (comma separated); with
 * it unset the suite runs every engine that reports itself available. Naming
 * an engine explicitly makes its unavailability a hard error rather than a
 * skip, so a CI job that means to exercise the flows engine cannot silently
 * pass by running only the legacy one.
 */
export const PARITY_ENGINES: readonly ParityEngine[] = [legacyEngine, flowsEngine];

export function getParityEngine(id: ParityEngineId): ParityEngine {
  const engine = PARITY_ENGINES.find((candidate) => candidate.id === id);
  if (!engine) throw new Error(`parity: no engine registered for ${id}`);
  return engine;
}

export type ParityEngineSelection = {
  readonly engines: readonly ParityEngine[];
  readonly skipped: readonly { readonly id: ParityEngineId; readonly reason: string }[];
};

export function selectParityEngines(
  raw: string | undefined = process.env.SMITHERS_PARITY_ENGINES,
): ParityEngineSelection {
  const requested = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (requested.length > 0) {
    const engines = requested.map((id) => {
      if (!isParityEngineId(id)) {
        throw new Error(`parity: SMITHERS_PARITY_ENGINES names an unknown engine: ${id}`);
      }
      const engine = getParityEngine(id);
      const reason = engine.unavailableReason();
      if (reason) {
        throw new Error(`parity: engine ${id} was requested explicitly but is unavailable: ${reason}`);
      }
      return engine;
    });
    return { engines, skipped: [] };
  }

  const engines: ParityEngine[] = [];
  const skipped: { id: ParityEngineId; reason: string }[] = [];
  for (const engine of PARITY_ENGINES) {
    const reason = engine.unavailableReason();
    if (reason) skipped.push({ id: engine.id, reason });
    else engines.push(engine);
  }
  if (engines.length === 0) {
    throw new Error("parity: no engine is available; the conformance suite cannot gate anything");
  }
  return { engines, skipped };
}

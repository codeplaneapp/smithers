/**
 * Every engine the parity suite can run a fixture on.
 *
 * "legacy" is `packages/engine`'s React-driver loop. "flows" is the
 * flows `FlowEngine` path landed by stage 1.3 of the flows migration
 * (`.smithers/specs/flows-migration.md`); until that lane lands it reports
 * itself unavailable and the suite runs the legacy engine alone.
 */
export type ParityEngineId = "legacy" | "flows";

export const PARITY_ENGINE_IDS: readonly ParityEngineId[] = ["legacy", "flows"];

export function isParityEngineId(value: string): value is ParityEngineId {
  return (PARITY_ENGINE_IDS as readonly string[]).includes(value);
}

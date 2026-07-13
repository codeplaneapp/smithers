import { toHarnessError, type HarnessError } from "../kernel/boundary.ts";
export class SimulationError extends Error { readonly fidelity = "simulation"; constructor(message: string, readonly code: string, readonly details?: unknown) { super(message); this.name = "SimulationError"; } }
export const normalizeHarnessError = (error: unknown): HarnessError => toHarnessError(error);

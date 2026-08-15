import type { ReasonBlocked } from "./ReasonBlocked.ts";
import type { ReasonUnhealthy } from "./ReasonUnhealthy.ts";
import type { RunState } from "./RunState.ts";
import type { RunStateWarning } from "./RunStateWarning.ts";

export type RunStateView = {
  runId: string;
  state: RunState;
  blocked?: ReasonBlocked;
  unhealthy?: ReasonUnhealthy;
  warnings?: RunStateWarning[];
  computedAt: string;
};

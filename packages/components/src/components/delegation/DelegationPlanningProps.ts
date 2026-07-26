import type { DelegationSharedProps } from "./DelegationSharedProps.ts";

export type DelegationPlanningProps = DelegationSharedProps & {
  /**
   * Root brief for standalone use. When omitted, planning waits for the
   * approved dcGoal row from the GoalRefinement phase and uses its
   * refinedPrompt.
   */
  prompt?: string;
};

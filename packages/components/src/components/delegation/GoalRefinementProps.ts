import type { DelegationSharedProps } from "./DelegationSharedProps.ts";

export type GoalRefinementProps = DelegationSharedProps & {
  /** The user's original (possibly ambiguous) ask. */
  prompt: string;
  /** Max user-preference questions the goal agent may forecast (default 10). */
  maxQuestions?: number;
  /** How many question forms haiku renders ahead of the user (default 10). */
  prefetchDepth?: number;
};

import type { DelegationSharedProps } from "./DelegationSharedProps.ts";

export type DelegationChainProps = DelegationSharedProps & {
  /** The user's original (possibly ambiguous) ask. Goal refinement turns it into the root context contract. */
  prompt: string;
  /** Max user-preference questions in goal refinement (default 10). */
  maxQuestions?: number;
  /** How many question forms haiku renders ahead of the user (default 10). */
  prefetchDepth?: number;
  /** Max exec/review attempts per leaf (default 3). */
  maxAttempts?: number;
  /** Max live edits accepted in one run (default 25). */
  maxEdits?: number;
};

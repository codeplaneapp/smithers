export type RalphState = {
  readonly iteration: number;
  readonly done: boolean;
  /**
   * True when the loop reached `maxIterations` under `onMaxReached: "return-last"`
   * with its `until` predicate still false. A `done` loop with `exhausted` set did
   * not converge — the run must not read as a clean success (#1464 AWF-1).
   */
  readonly exhausted?: boolean;
};

/**
 * One unit of rollout work: a single benchmark instance (e.g. one SWE-Bench Pro
 * instance id, one RoadmapBench slug). The scoring half is separate and runs on
 * the amd64 Docker pool, so a task here is only the agent rollout.
 */
export type BenchmarkTask = {
  /** Unique across the run (e.g. `swe-bench-pro:django__django-12345`). */
  id: string;
  /** Which suite this instance belongs to. */
  benchmark: string;
  /**
   * Relative cost of this task (default 1). Long-horizon tasks (RoadmapBench,
   * SWE-EVO) weigh more so a sub with less headroom gets fewer of them.
   */
  weight?: number;
};

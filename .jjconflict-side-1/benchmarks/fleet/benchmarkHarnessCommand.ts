import type { HarnessCommand } from "./HarnessCommand";

/**
 * The Claude-only command to run a benchmark's OWN harness for a shard of
 * instance ids. These benchmarks ship a per-instance workflow + dataset fetcher
 * in-repo, so the fleet shards the ids and each container runs the harness for
 * its subset — it does not re-implement the benchmark. (Open-ended tasks use the
 * delegation path instead; see buildDelegationShardTasks.)
 *
 * Model matrix per your rules: implementation is Claude (never Codex); Codex is
 * allowed as a REVIEWER. A single `--reviewer`/refine model is one reviewer — a
 * true Codex+Opus review PANEL is the harness edit noted in the README (wire in
 * review-panel.tsx). Datasets are fetched first by each benchmark's own script
 * (swe-bench-pro `scripts/fetch-dataset.js`, swe-evo `dataset/load.ts`,
 * roadmapbench `harness/launch_benchmark.sh`).
 */
export function benchmarkHarnessCommand(
  benchmark: string,
  ids: readonly string[],
  opts: { implementer?: string; reviewer?: string } = {},
): HarnessCommand {
  const implementer = opts.implementer ?? "claude-sonnet-5";
  const reviewer = opts.reviewer ?? "gpt-5.5"; // Codex, review only
  switch (benchmark) {
    case "swe-bench-pro":
      return {
        command: "node",
        args: [
          "benchmarks/swe-bench-pro/scripts/cli.js",
          "run",
          "--ids",
          ids.join(","),
          "--implementer",
          implementer, // was gpt-5.5 — Claude now
          "--reviewer",
          reviewer,
          "--gateway",
        ],
        env: {},
      };
    case "swe-evo":
      return {
        command: "bun",
        args: ["examples/swe-evo/run.ts", ...ids],
        // implement already Opus (Claude); refine is the Codex reviewer.
        env: { SWEEVO_CLAUDE_MODEL: opts.implementer ?? "claude-opus-4-8", SWEEVO_CODEX_MODEL: reviewer },
      };
    case "roadmapbench":
      return {
        command: "bash",
        args: ["benchmarks/roadmapbench/harness/launch_benchmark.sh", ...ids],
        // plan/implement/finalize already Opus (Claude); review is the Codex reviewer.
        env: { ROADMAPBENCH_REVIEW_MODEL: reviewer },
      };
    default:
      throw new Error(`benchmarkHarnessCommand: unknown benchmark "${benchmark}"`);
  }
}

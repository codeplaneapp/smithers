// Shared RoadmapBench reward scorer: runs the task's own hidden weighted test
// suite via the fair-validated harness (benchmarks/roadmapbench/harness) in a
// fresh --network none container, and persists the authoritative score.json
// into the run's workDir. Used by orchbench.tsx (and future benchmark
// workflows); roadmapbench.tsx keeps its own inline copy for stability.
import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createScorer } from "smithers-orchestrator";

const HARNESS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../benchmarks/roadmapbench/harness",
);

export type RoadmapScorerInput = {
  taskId: string;
  image: string;
  repoDir: string;
  testsDir: string;
  workDir: string;
};

export function roadmapScorer(input: RoadmapScorerInput) {
  return createScorer({
    id: "roadmapbench-reward",
    name: "RoadmapBench Reward",
    description:
      "Weighted fraction of per-target hidden tests that pass (the official RoadmapBench reward).",
    score: async () => {
      const outDir = join(input.workDir, "score");
      const reward = await new Promise<{ reward: number; raw: string }>(
        (resolve) => {
          execFile(
            "bash",
            [
              join(HARNESS, "score.sh"),
              input.image,
              input.repoDir,
              input.testsDir,
              outDir,
            ],
            { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 },
            (_err, stdout) => {
              const last = String(stdout).trim().split("\n").pop() ?? "0";
              const n = Number.parseFloat(last);
              resolve({ reward: Number.isFinite(n) ? n : 0, raw: String(stdout) });
            },
          );
        },
      );
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(readFileSync(join(outDir, "reward.json"), "utf8"));
      } catch {
        /* reward.json absent → reward stays 0 */
      }
      try {
        writeFileSync(
          join(input.workDir, "score.json"),
          JSON.stringify({ taskId: input.taskId, ...meta, reward: reward.reward }, null, 2),
        );
      } catch {
        /* best effort */
      }
      return {
        score: reward.reward,
        reason: `RoadmapBench reward ${reward.reward} (${JSON.stringify(meta)})`,
        meta,
      };
    },
  });
}

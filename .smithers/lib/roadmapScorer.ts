// Shared RoadmapBench reward scorer: runs the task's own hidden weighted test
// suite via the fair-validated harness (benchmarks/roadmapbench/harness) in a
// fresh isolated container, and persists the authoritative score.json
// into the run's workDir. Used by orchbench.tsx (and future benchmark
// workflows); roadmapbench.tsx keeps its own inline copy for stability.
import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createScorer } from "smthrs";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "../../benchmarks/roadmapbench/harness");

export type RoadmapScorerInput = {
  taskId: string;
  image: string;
  repoDir: string;
  testsDir: string;
  workDir: string;
};

export type RoadmapScoreResult = {
  reward: number;
  meta: Record<string, unknown>;
  raw: string;
};

export async function runRoadmapScore(input: RoadmapScorerInput, checkpoint?: string): Promise<RoadmapScoreResult> {
  const suffix = checkpoint ? `-${checkpoint}` : "";
  const outDir = join(input.workDir, `score${suffix}`);
  // score.sh snapshots every candidate before mounting it read-write, so both
  // intermediate and final grading leave the submitted artifact untouched.
  const reward = await new Promise<{ reward: number; raw: string }>((resolve, reject) => {
    execFile(
      "bash",
      [join(HARNESS, "score.sh"), input.image, input.repoDir, input.testsDir, outDir],
      { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const raw = String(stdout);
        if (err) {
          reject(new Error(`RoadmapBench scorer failed: ${err.message}\n${String(stderr).slice(-4000)}`));
          return;
        }
        const last = raw.trim().split("\n").pop() ?? "0";
        const n = Number.parseFloat(last);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          reject(new Error(`RoadmapBench scorer returned an invalid reward: ${raw.slice(-4000)}`));
          return;
        }
        resolve({ reward: n, raw });
      },
    );
  });
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(readFileSync(join(outDir, "reward.json"), "utf8"));
  } catch (err) {
    throw new Error(`RoadmapBench scorer did not produce valid reward metadata: ${String(err)}`);
  }
  const metadataReward = Number(meta.reward);
  if (!Number.isFinite(metadataReward) || metadataReward < 0 || metadataReward > 1) {
    throw new Error(`RoadmapBench scorer metadata has an invalid reward: ${String(meta.reward)}`);
  }
  if (Math.abs(metadataReward - reward.reward) > 1e-12) {
    throw new Error(`RoadmapBench scorer stdout/metadata mismatch: ${reward.reward} != ${metadataReward}`);
  }
  try {
    writeFileSync(
      join(input.workDir, `score${suffix}.json`),
      JSON.stringify(
        { taskId: input.taskId, checkpoint: checkpoint ?? "final", ...meta, reward: reward.reward },
        null,
        2,
      ),
    );
  } catch {
    /* best effort */
  }
  return { reward: reward.reward, meta, raw: reward.raw };
}

export function roadmapScorer(input: RoadmapScorerInput) {
  return createScorer({
    id: "roadmapbench-reward",
    name: "RoadmapBench Reward",
    description: "Weighted fraction of per-target hidden tests that pass (the official RoadmapBench reward).",
    score: async () => {
      const result = await runRoadmapScore(input);
      return {
        score: result.reward,
        reason: `RoadmapBench reward ${result.reward} (${JSON.stringify(result.meta)})`,
        meta: result.meta,
      };
    },
  });
}

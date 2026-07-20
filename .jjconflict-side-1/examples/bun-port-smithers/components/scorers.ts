import { latencyScorer, llmJudge, schemaAdherenceScorer } from "smithers-orchestrator/scorers";

import { agentsForRepo } from "./agents";

export function standardScorers(repo: string, targetMs = 30_000): any {
  return {
    schema: { scorer: schemaAdherenceScorer(), sampling: "all" },
    latency: { scorer: latencyScorer({ targetMs, maxMs: targetMs * 4 }), sampling: "all" },
    porting: {
      sampling: process.env.BUN_PORT_ENABLE_JUDGE_SCORERS === "1" ? "ratio" : "none",
      scorer: llmJudge({
        id: "porting-guide-adherence",
        name: "PORTING.md adherence",
        description: "Checks whether the task output claims to follow the Bun porting guide.",
        judge: agentsForRepo(repo).judge,
        instructions: "Return JSON with score from 0 to 1 and reason. Reward concrete adherence to Bun docs/PORTING.md.",
        promptTemplate: ({ input, output }) =>
          `Evaluate this Bun Zig-to-Rust workflow result.\n\nINPUT:\n${String(input)}\n\nOUTPUT:\n${JSON.stringify(output, null, 2)}`,
      }),
    },
  };
}

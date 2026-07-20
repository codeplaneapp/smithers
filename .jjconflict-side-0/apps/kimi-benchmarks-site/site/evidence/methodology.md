# Controlled Kimi K3 RoadmapBench run

- Task: `vbt-1.2.0-roadmap` (Valibot 1.1 to 1.2)
- Candidate roles: planning, implementation, and finalization
- Candidate engine/model: OpenCode 1.18.3, `kimi-for-coding/k3`
- Independent review: Codex, `gpt-5.5`, xhigh reasoning
- Model pool: Kimi K3 x3, GPT-5.5 x1
- Attempts: one per stage; no retry or fallback
- Official weighted reward: 1.000 (3/3 targets)
- Exact prior baseline: Claude Opus 4.8 candidate roles plus the same GPT-5.5 reviewer, 0.714 (2/3 targets)

## Fairness controls

The task image and scorer were validated before the run: the untouched source scored 0.0 and the oracle patch scored 1.0 through the same scoring path. Agents saw only the source-version checkout and roadmap instruction. The project toolchain container was offline, OpenCode network-search tools were denied, and a post-hoc audit found zero integrity signals across 62 recorded commands.

The hidden target tests were introduced only after agent execution. They reported 67 coercion tests, 12 examples/metadata tests, and 15 ISBN tests passing.

## Interpretation

This is a one-task controlled comparison, not a 115-task RoadmapBench leaderboard result. The retained independent reviewer means the result belongs to a Kimi-led Smithers stack rather than a pure single-model scaffold. The reviewer found no roadmap defect and applied no fix.

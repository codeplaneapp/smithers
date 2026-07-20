# Exact-task Claude Opus baseline

Task: `vbt-1.2.0-roadmap` — Valibot 1.1 to 1.2 (TypeScript, medium)

- Candidate roles: Claude Opus 4.8
- Independent reviewer: Codex GPT-5.5
- Reward: 0.714
- Targets: 2/3
- Weights: `[3, 2, 2]`
- Passing targets retained in the historical summary: the weight-3 target and one weight-2 target

The historical result did not preserve which of the two weight-2 targets failed, so the comparison report does not infer it.

The original Smithers benchmark summary also records a clean command audit and validated scorer controls (oracle 1.0, untouched source 0.0).

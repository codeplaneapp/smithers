# guidance-interactive

**Feature under test:** the "hand humans interactive commands" rule — when an agent
gives a human a copy-paste command, it must include the `--interactive` flag whenever
the command supports it (`up --interactive`, `workflow run <id> --interactive`), and
must not hand the human a detached run.

**Docs/skill surface exercised:**
- `skills/smithers/SKILL.md` — "How to guide the user" standing behavior 4
  ("Hand humans interactive commands").
- `docs/cli/overview.mdx` — "Interactive mode and the full-screen TUI monitor"
  (the agent-directed paragraph), which flows into `docs/llms-core.txt` /
  `llms-full.txt`.

**Verify:** deterministic `contains` — the artifact must include `--interactive`
(plus the workflow name/file where the task names one) and must not include
`--detach`. No model spend on verification.

**Failure meaning:** a red case means the docs/skill guidance is not strong or
findable enough for a weak model to consistently hand humans the interactive form —
tighten the wording or surface it in more places.

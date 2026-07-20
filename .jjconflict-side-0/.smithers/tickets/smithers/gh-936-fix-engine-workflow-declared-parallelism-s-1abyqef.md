# 🐛 fix(engine): workflow-declared parallelism silently clamped by the 16-slot auto-raise ceiling

GitHub: https://github.com/smithersai/smithers/issues/936

A workflow declaring `<Parallel maxConcurrency={64}>` runs at 16: the slot governor auto-raises the engine cap only up to SMITHERS_AUTO_MAX_CONCURRENCY_CEILING (default 16), and nothing at launch or in the UIs says the workflow asked for more. Operators read the workflow source, see 64, and reasonably conclude the monitor is buggy.

Fix ideas (any subset):
- `workflow run`/`up` derive the default engine cap from the workflow's declared Parallel widths (the graph knows them statically).
- The governor's pinned-ceiling warning should also surface in run state (health strip / `smithers why`), not just a log line.
- Document the ceiling env + --max-concurrency interplay on the run commands.

Workaround verified: `--max-concurrency 64` (explicit pin) plus the env ceiling.

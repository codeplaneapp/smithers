# factory/

The software factory: everything that turns queued prompts into landed,
documented commits. The process design lives in the spec vault, a separate
repository: the "Software Factory" spec (process), the "Clean History" spec
(the `vibe`/`main` branch model), and the "Colocated Docs" spec (documentation
planes).

## Contents

- `queue/` — the intake. One markdown file per requested change; presence is
  registration. See `queue/README.md`.
- `flows/` — factory production lines: flows that run on the Smithers library
  itself (`harness.ts` holds the `AgentTask`/`ShellTask` atoms). Launch with
  `bun factory/flows/<name>.ts`.
- `reports/` — each flow's output: a summary markdown per flow plus tailable
  per-task logs.

## Planned

Factory tooling consolidates here over time. The queue-driver workflow
(`.smithers/workflows/queue-driver.tsx`, untracked today) and the factory
flow that replaces it (queue item `0003-factory-flow`) move under this
directory when they become tracked code.

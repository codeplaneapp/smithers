# Hijacked chat pipeline

This example is a three-step Smithers pipeline where every task is a real
hijacked Codex session presented through a custom browser chat UI:

1. **Scope** collaborates with you and writes a durable brief.
2. **Plan** reads the brief, collaborates on the approach, and writes a plan.
3. **Deliver** reads both artifacts, implements the change, and verifies it.

The message bubbles and glass composer come from
`smithers-orchestrator/ui`. The example only owns the Gateway candidate polling,
PTY WebSocket transport, and a small ANSI/VT screen model used to turn native
CLI redraws into readable assistant output.

## Run it

Start the workflow in detached mode with a concrete goal:

```bash
bunx smithers-orchestrator up examples/hijacked-chat-pipeline/workflow.tsx \
  --detach \
  --input '{"goal":"Add a focused improvement to this repository"}'
```

Copy the printed run id, then open its workflow-owned UI:

```bash
bunx smithers-orchestrator ui <run-id>
```

`smithers ui` starts or reuses the workspace Gateway. The CLI-started Gateway
provides the `/v1/pty/hijack` WebSocket that the browser needs to attach to the
native session.

For each stage, chat with the agent until the work for that stage is done. Ask
it to finish with the raw `{}` required by the task output, then click **Return
control**. The UI sends Ctrl+D to end the native CLI session; Smithers resumes
the run and advances to the next hijacked task automatically.

Stage handoff files are written beneath
`.smithers/executions/<run-id>/hijacked-chat-pipeline/`, which is already ignored
by the repository.

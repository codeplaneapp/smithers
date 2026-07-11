# Former init-pack workflows

These workflows were previously installed by smithers init. They remain as copyable examples, but the default pack is intentionally limited to create-workflow, create-skill, and docs-driven-development plus hidden system plumbing. The monitoring surface is smithers monitor / Gateway /monitor; monitor helper generators are intentionally not seeded.

Each archived source below is a complete example entry point. Copy the file and the relative imports it names, then run `smithers graph examples/init-pack/<id>.tsx` (or use the matching `workflow run` command after copying it into `.smithers/workflows/`).

| Example | What it demonstrates | Copy/run entry point |
| --- | --- | --- |
| vcs | Inspect git or jj state and plan safe changes. | `vcs.tsx` → `smithers graph examples/init-pack/vcs.tsx` |
| implement | Implement a request with validation. | `implement.tsx` → `smithers graph examples/init-pack/implement.tsx` |
| research-plan-implement | Research, plan, implement, and review. | `research-plan-implement.tsx` → `smithers graph examples/init-pack/research-plan-implement.tsx` |
| review | Review repository changes. | `review.tsx` → `smithers graph examples/init-pack/review.tsx` |
| plan | Produce an ordered implementation plan. | `plan.tsx` → `smithers graph examples/init-pack/plan.tsx` |
| research | Produce grounded research findings. | `research.tsx` → `smithers graph examples/init-pack/research.tsx` |
| ticket-create | Create one scoped ticket. | `ticket-create.tsx` → `smithers graph examples/init-pack/ticket-create.tsx` |
| tickets-create | Split a project into actionable tickets. | `tickets-create.tsx` → `smithers graph examples/init-pack/tickets-create.tsx` |
| ralph | Iterate until validation criteria hold. | `ralph.tsx` → `smithers graph examples/init-pack/ralph.tsx` |
| improve-test-coverage | Add high-value regression tests. | `improve-test-coverage.tsx` → `smithers graph examples/init-pack/improve-test-coverage.tsx` |
| debug | Diagnose and verify a fix. | `debug.tsx` → `smithers graph examples/init-pack/debug.tsx` |
| grill-me | Clarify a vague request. | `grill-me.tsx` → `smithers graph examples/init-pack/grill-me.tsx` |
| feature-enum | Inventory and classify features. | `feature-enum.tsx` → `smithers graph examples/init-pack/feature-enum.tsx` |
| audit | Audit quality and reliability gaps. | `audit.tsx` → `smithers graph examples/init-pack/audit.tsx` |
| mission | Coordinate a milestone with approvals. | `mission.tsx` → `smithers graph examples/init-pack/mission.tsx` |
| workflow-skill | Document how to operate a workflow. | `workflow-skill.tsx` → `smithers graph examples/init-pack/workflow-skill.tsx` |
| kanban | Run bounded parallel tickets. | `kanban.tsx` → `smithers graph examples/init-pack/kanban.tsx` |
| hello | Verify the smallest workflow graph. | `hello.tsx` → `smithers graph examples/init-pack/hello.tsx` |
| context-engineer | Route context-heavy engineering work. | `context-engineer.tsx` → `smithers graph examples/init-pack/context-engineer.tsx` |
| route-task | Classify and route a request. | `route-task.tsx` → `smithers graph examples/init-pack/route-task.tsx` |
| extract-skill | Extract a reusable skill. | `extract-skill.tsx` → `smithers graph examples/init-pack/extract-skill.tsx` |
| triage-run | Diagnose a failed or stuck run. | `triage-run.tsx` → `smithers graph examples/init-pack/triage-run.tsx` |
| context-doctor | Recover from context pressure. | `context-doctor.tsx` → `smithers graph examples/init-pack/context-doctor.tsx` |
| backpressure-plan | Plan bounded work under pressure. | `backpressure-plan.tsx` → `smithers graph examples/init-pack/backpressure-plan.tsx` |
| eval-author | Author a workflow evaluation suite. | `eval-author.tsx` → `smithers graph examples/init-pack/eval-author.tsx` |
| report-slideshow | Generate an HTML run report. | `report-slideshow.tsx` → `smithers graph examples/init-pack/report-slideshow.tsx` |
| smithering | Route work through a durable pipeline. | `smithering.tsx` → `smithers graph examples/init-pack/smithering.tsx` |
| delegation-chain | Delegate through specialist tasks. | `delegation-chain.tsx` → `smithers graph examples/init-pack/delegation-chain.tsx` |
| make-workflow-tutorial | Guide first-time workflow authoring. | `make-workflow-tutorial.tsx` → `smithers graph examples/init-pack/make-workflow-tutorial.tsx` |

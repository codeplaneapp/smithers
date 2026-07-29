# Smithers 0.31.1 launch thread

Production-hardening shape: hook with scale, headline feature (monitor workflows) on tweet 2, recovery ergonomics on 3-4, fix-count tweet on 5, safe defaults + CTA on 6. charCounts recomputed as actual Unicode character length with the CTA URL normalized to 23 chars (t.co). Cut per ledger flags: examples coverage, OrchBench numbers, and marketing-deck removal are allowedInMarketing:false; ui-core/tui-ui extraction and gateway child-run APIs stayed in the changelog to keep the thread at 6 tweets.

---

### 1. Tweet 1

> Smithers 0.31.1 is out. 163 commits, 993 files changed.
>
> First-class monitor workflows, resumable runs after in-flight workflow edits, and durable subflow fixes across the engine.
>
> bunx smithers-orchestrator@latest init
>
> 1/6

Claim IDs: claim-163-commits-993-files, claim-monitor-workflows, claim-retry-task-accept-workflow-change, claim-subflow-hardening-batch
Characters: 224

---

### 2. Tweet 2

> New: monitor workflows.
>
> Drop a .smithers/monitor/<workflowId>.tsx next to a workflow and it watches every run: auto-heal stalled or wedged nodes, or escalate to a human through a durable HumanTask.
>
> 2/6

Claim IDs: claim-monitor-workflows
Characters: 203

---

### 3. Tweet 3

> Edited the workflow file while a run was in flight? retry-task --accept-workflow-change resumes the run with the new definition instead of failing with RESUME_METADATA_MISMATCH. The mismatch error now names the flag.
>
> 3/6

Claim IDs: claim-retry-task-accept-workflow-change
Characters: 221

---

### 4. Tweet 4

> smithers claude monitor now fires on retry churn and long silence on live runs, not just discrete bad transitions. And smithers oneshot warns on a dirty working copy and has the agent triage it before starting the goal.
>
> 4/6

Claim IDs: claim-monitor-retry-silence-alerts, claim-oneshot-dirty-workdir-triage
Characters: 224

---

### 5. Tweet 5

> The honest shape of this release: 80 of 163 commits are fixes. Child-run cancel/pause propagation, signals across child waits, a <Task deps> completion race (#1415), and a silent jj revert no-op are all fixed.
>
> 5/6

Claim IDs: claim-163-commits-993-files, claim-subflow-hardening-batch, claim-async-deps-completion-fix, claim-jj-commit-id-pointer-fix
Characters: 214

---

### 6. Tweet 6

> Safer defaults: allowNetwork:false now keeps loopback reachable (local dev servers, local Postgres) while still denying remote egress. Evals grade harness deaths INCONCLUSIVE instead of failed.
>
> https://smithers.sh
>
> 6/6

Claim IDs: claim-loopback-sandbox-fix, claim-eval-inconclusive-grading
Characters: 219

---

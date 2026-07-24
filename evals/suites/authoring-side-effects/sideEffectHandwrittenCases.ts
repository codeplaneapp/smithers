type HandwrittenCase = {
  id: string;
  task: string;
  requireIdempotencyKey?: boolean;
  requireRevert?: boolean;
};

/** Curated edge cases kept separate from the generated scenario cross-product. */
export const sideEffectHandwrittenCases: HandwrittenCase[] = [
  { id: "hw-gh-pr-view-unmarked", task: "Write a workflow that runs `gh pr view 17`. It is read-only, so do not mark it as a side effect." },
  { id: "hw-gh-pr-status-unmarked", task: "Write a workflow that runs `gh pr status`. Keep the task unmarked." },
  { id: "hw-gh-issue-list-unmarked", task: "Write a workflow that runs `gh issue list`. Keep the task unmarked." },
  { id: "hw-gh-pr-merge-marked", task: "Write a workflow that runs `gh pr merge 17` from a sideEffect:true tool and uses ctx.idempotencyKey.", requireIdempotencyKey: true },
  { id: "hw-gh-api-get-unmarked", task: "Write a workflow using `gh api -X GET repos/o/r`. Do not over-mark the read." },
  { id: "hw-gh-api-post-marked", task: "Write a workflow using `gh api -X POST repos/o/r/issues` inside a marked tool with ctx.idempotencyKey.", requireIdempotencyKey: true },
  { id: "hw-fetch-default-get", task: "Write a read-only workflow that calls fetch('/api/report') with no method. Do not mark it." },
  { id: "hw-fetch-head", task: "Write a read-only workflow that calls fetch with method HEAD. Do not mark it." },
  { id: "hw-fetch-delete", task: "Write a workflow that calls fetch with method DELETE inside a marked tool." },
  { id: "hw-axios-get", task: "Write a workflow that reads with axios.get and remains unmarked." },
  { id: "hw-axios-patch", task: "Write a workflow that updates through axios.patch inside a marked tool." },
  { id: "hw-wrangler-dry-run", task: "Write a workflow that runs `wrangler deploy --dry-run`. Do not mark the dry run." },
  { id: "hw-wrangler-real-deploy", task: "Write a workflow that runs a real `wrangler deploy` from a marked compute Task." },
  { id: "hw-terraform-plan", task: "Write a workflow that runs `terraform plan`. Do not mark it." },
  { id: "hw-terraform-apply", task: "Write a workflow that runs `terraform apply` inside a sideEffect:true tool." },
  { id: "hw-git-push", task: "Write a workflow that commits and pushes a git branch. Neither operation is an external side effect under the git exemption." },
  { id: "hw-git-push-gh-merge", task: "Write a workflow that pushes a branch and then merges its PR. Mark the `gh pr merge` operation, not git push." },
  { id: "hw-jj-sweep", task: "Write a workflow that uses jj new, describe, and bookmark set. Keep all tasks unmarked." },
  { id: "hw-relative-codegen", task: "Write generated client code to src/generated/client.ts. Keep the in-repo write unmarked." },
  { id: "hw-absolute-repo-codegen", task: "Write generated client code to /repo/src/generated/client.ts. Keep the in-repo write unmarked." },
  { id: "hw-tmp-report", task: "Write /tmp/report.json from a sideEffect compute Task." },
  { id: "hw-var-log", task: "Append audit output to /var/log/workflow.log from a marked tool." },
  { id: "hw-template-gh-view", task: "Build `gh pr view ${id}` with a template literal and run it. Do not mark it." },
  { id: "hw-template-gh-merge", task: "Build `gh pr merge ${id}` with a template literal and run it from a marked tool." },
  { id: "hw-concat-terraform-plan", task: "Build 'terraform ' + 'plan' and execute it. Do not mark it." },
  { id: "hw-concat-terraform-apply", task: "Build 'terraform ' + 'apply' and execute it inside a marked tool." },
  { id: "hw-save-report-slack", task: "A task named save-report posts with slack.chat.postMessage. Mark the actual effect and thread ctx.idempotencyKey.", requireIdempotencyKey: true },
  { id: "hw-log-metrics-post", task: "A task named log-metrics POSTs to a metrics endpoint. Mark the actual effect." },
  { id: "hw-read-dashboard", task: "Build a dashboard workflow that only performs GET fetches. Over-marking must be avoided." },
  { id: "hw-mixed-read-send", task: "Build a workflow with one GET reader and one Slack sender. Only the sender should be marked." },
  { id: "hw-pure-task-overmark", task: "Build an in-memory ETL compute Task. Do not set sideEffect on it." },
  { id: "hw-pure-tool-overmark", task: "Build a defineTool that sorts supplied rows and returns them. Keep sideEffect false." },
  { id: "hw-revert-without-mark", task: "Post to Slack with a defineTool that supports time-travel compensation. Put revert and sideEffect:true on the same tool.", requireRevert: true },
  { id: "hw-blind-delete-revert", task: "Post to Slack and support clean time travel. The revert must find the message before deleting it, never blindly delete.", requireRevert: true },
  { id: "hw-unknown-status-revert", task: "Post to Slack and support clean time travel. The revert must undo known-succeeded posts and probe existence before undoing an unknown, verified-present post.", requireRevert: true },
  { id: "hw-revert-no-undo", task: "Post to Slack and support clean time travel. The revert must both verify and actually undo the post.", requireRevert: true },
  { id: "hw-stripe-refund-revert", task: "Charge with Stripe and support clean time travel by finding the charge before issuing a refund.", requireRevert: true },
  { id: "hw-webhook-delete-revert", task: "Register a webhook and support clean time travel by looking it up before deleting it.", requireRevert: true },
  { id: "hw-idempotency-missing", task: "Send an email from a sideEffect:true, idempotent:false tool and thread ctx.idempotencyKey to the provider.", requireIdempotencyKey: true },
  { id: "hw-compute-task-marking", task: "Call telegram.sendMessage directly in a compute Task. Use the Task sideEffect prop rather than an unrelated pure tool marker." },
];

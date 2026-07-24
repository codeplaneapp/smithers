type BaseScenario = {
  id: string;
  effectClass: string;
  task: string;
};

type Scenario = BaseScenario & {
  variant: "tool-key" | "tool-revert" | "compute-task" | "pure" | "adversarial";
  requireIdempotencyKey: boolean;
  requireRevert: boolean;
};

const effects: BaseScenario[] = [
  { id: "slack-message", effectClass: "messaging", task: "post a release announcement with slack.chat.postMessage" },
  { id: "telegram-message", effectClass: "messaging", task: "send an operations update with telegram.sendMessage" },
  { id: "email-send", effectClass: "messaging", task: "send a completion email with a nodemailer transport.sendMail call" },
  { id: "discord-message", effectClass: "messaging", task: "publish a Discord update with discord.createMessage" },
  { id: "twitter-post", effectClass: "social", task: "publish a social update with twitter.v2.tweet" },
  { id: "linkedin-post", effectClass: "social", task: "publish a LinkedIn update with social.createPost" },
  { id: "github-pr-merge", effectClass: "github-api", task: "merge an approved pull request with `gh pr merge`" },
  { id: "github-pr-close", effectClass: "github-api", task: "close a stale pull request with `gh pr close`" },
  { id: "github-pr-comment", effectClass: "github-api", task: "comment on a pull request with `gh pr comment`" },
  { id: "github-issue-create", effectClass: "github-api", task: "create a GitHub issue with `gh issue create`" },
  { id: "github-release-create", effectClass: "github-api", task: "create a GitHub release with `gh release create`" },
  { id: "wrangler-deploy", effectClass: "deploy", task: "deploy a worker with `wrangler deploy`" },
  { id: "kubectl-apply", effectClass: "deploy", task: "apply a Kubernetes manifest with `kubectl apply -f app.yaml`" },
  { id: "terraform-apply", effectClass: "deploy", task: "apply reviewed infrastructure with `terraform apply`" },
  { id: "fly-deploy", effectClass: "deploy", task: "deploy the service with `flyctl deploy`" },
  { id: "npm-publish", effectClass: "package-publish", task: "publish a package with `npm publish`" },
  { id: "docker-push", effectClass: "package-publish", task: "publish an image with `docker push registry.example/app:latest`" },
  { id: "database-insert", effectClass: "external-database", task: "insert the processed record with db.insert" },
  { id: "prisma-update", effectClass: "external-database", task: "update an external user record with prisma.user.update" },
  { id: "supabase-delete", effectClass: "external-database", task: "delete an expired external row with supabase.table.delete" },
  { id: "s3-put-object", effectClass: "object-storage", task: "upload a report with s3.putObject" },
  { id: "s3-delete-object", effectClass: "object-storage", task: "remove an obsolete object with s3.deleteObject" },
  { id: "stripe-charge", effectClass: "payments", task: "charge a customer with stripe.charges.create" },
  { id: "stripe-refund", effectClass: "payments", task: "issue a refund with stripe.refunds.create" },
  { id: "webhook-register", effectClass: "registration", task: "register a callback with hooks.registerWebhook" },
  { id: "cron-register", effectClass: "registration", task: "register a scheduled job with cron.scheduleJob" },
  { id: "pagerduty-trigger", effectClass: "incident", task: "trigger an incident with pagerduty.triggerIncident" },
  { id: "sentry-capture", effectClass: "incident", task: "send a captured exception with Sentry.captureException" },
];

const negatives: BaseScenario[] = [
  { id: "git-commit-only", effectClass: "git-only", task: "commit generated changes with git commit; this is git-owned state" },
  { id: "git-push-only", effectClass: "git-only", task: "push a topic branch with git push; this is git-owned state" },
  { id: "jj-bookmark-only", effectClass: "git-only", task: "move a jj bookmark; this is VCS-owned state" },
  { id: "pure-analysis", effectClass: "pure-analysis", task: "score an in-memory array and return the highest-risk item" },
  { id: "pure-etl", effectClass: "pure-analysis", task: "transform supplied JSON rows into a normalized in-memory result" },
  { id: "repo-codegen-relative", effectClass: "in-repo-write", task: "generate src/schema.ts inside the repository" },
  { id: "repo-codegen-absolute", effectClass: "in-repo-write", task: "write generated.ts beneath /repo, the supplied repository root" },
  { id: "read-dashboard-fetch", effectClass: "read-only", task: "build a read-only dashboard from a default GET fetch" },
  { id: "read-dashboard-axios", effectClass: "read-only", task: "load dashboard data with axios.get" },
  { id: "github-pr-view", effectClass: "read-only", task: "inspect a pull request with `gh pr view 42`" },
  { id: "terraform-plan", effectClass: "read-only", task: "produce a Terraform plan with `terraform plan`" },
  { id: "wrangler-dry-run", effectClass: "read-only", task: "validate a worker with `wrangler deploy --dry-run`" },
];

const adversarial: Array<BaseScenario & { requireIdempotencyKey?: boolean; requireRevert?: boolean }> = [
  { id: "view-then-merge", effectClass: "github-boundary", task: "view PR 42, then merge it; mark the merge path but do not treat the view as an external mutation" },
  { id: "get-then-post", effectClass: "network-boundary", task: "GET the current report, then POST a new report; only the POST is effectful" },
  { id: "dry-run-then-deploy", effectClass: "deploy-boundary", task: "run `wrangler deploy --dry-run`, then run the real `wrangler deploy`; mark the real deploy" },
  { id: "plan-then-apply", effectClass: "deploy-boundary", task: "run `terraform plan`, then `terraform apply`; mark apply but not plan" },
  { id: "save-report-slack", effectClass: "hidden-effect", task: "implement a step called save-report that actually posts the report with slack.chat.postMessage", requireIdempotencyKey: true },
  { id: "log-metrics-post", effectClass: "hidden-effect", task: "implement log-metrics using fetch with method POST", requireIdempotencyKey: true },
  { id: "push-vs-merge", effectClass: "github-boundary", task: "push a git branch and merge its GitHub PR; git push is exempt but `gh pr merge` must be marked" },
  { id: "mixed-markings", effectClass: "mixed", task: "build one read-only task, one correctly marked Slack tool, and one correctly marked `gh issue create` tool" },
  { id: "repo-vs-tmp-write", effectClass: "filesystem-boundary", task: "write one generated file under /repo and one report under /tmp; mark only the /tmp mutation" },
  { id: "unknown-status-revert", effectClass: "revert-contract", task: "post to Slack and support clean time travel with a revert that undoes succeeded posts and, for unknown status, probes existence before deleting only a verified-present post", requireRevert: true },
  { id: "existence-check-revert", effectClass: "revert-contract", task: "post to Slack and support clean time travel with findMessageByKey followed by guarded deletion", requireRevert: true },
  { id: "refund-as-revert", effectClass: "revert-contract", task: "charge with Stripe and support clean time travel by finding the charge before creating a refund", requireRevert: true },
];

const variants = [
  {
    id: "tool-key",
    instruction: "Implement the mutation inside defineTool with sideEffect metadata. Thread ctx.idempotencyKey into the external call.",
    requireIdempotencyKey: true,
    requireRevert: false,
  },
  {
    id: "tool-revert",
    instruction: "Implement the mutation inside defineTool with sideEffect metadata and ctx.idempotencyKey. Add a revert handler that verifies the effect before undoing it and tolerates unknown status.",
    requireIdempotencyKey: true,
    requireRevert: true,
  },
  {
    id: "compute-task",
    instruction: "Implement the external call directly in a compute Task and use the Task sideEffect prop. Do not add sideEffect metadata to pure tasks.",
    requireIdempotencyKey: false,
    requireRevert: false,
  },
] as const;

/** 108 deterministic scenario rows: 84 effect variants, 12 pure negatives, and 12 adversarial boundaries. */
export const scenarios: Scenario[] = [
  ...effects.flatMap((effect) =>
    variants.map((variant) => ({
      ...effect,
      variant: variant.id,
      task: `Write a complete Smithers workflow that will ${effect.task}. ${variant.instruction}`,
      requireIdempotencyKey: variant.requireIdempotencyKey,
      requireRevert: variant.requireRevert,
    })),
  ),
  ...negatives.map((scenario) => ({
    ...scenario,
    variant: "pure" as const,
    task: `Write a complete Smithers workflow that will ${scenario.task}. Keep pure or git-owned work unmarked. Over-marking is a failure.`,
    requireIdempotencyKey: false,
    requireRevert: false,
  })),
  ...adversarial.map((scenario) => ({
    ...scenario,
    variant: "adversarial" as const,
    task: `Write a complete Smithers workflow that will ${scenario.task}. Apply side-effect markings exactly at the external-state boundary.`,
    requireIdempotencyKey: scenario.requireIdempotencyKey ?? false,
    requireRevert: scenario.requireRevert ?? false,
  })),
];

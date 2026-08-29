import { createSmithers, Parallel, Ralph, Sequence, on } from "@smithers-ai/workflow";
import { ClaudeCodeAgent, CodexAgent, Worktree } from "smithers-orchestrator";
import { z } from "zod";

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const MAX_REVIEW_ROUNDS =
  Number.parseInt(process.env.ISSUE_PIPELINE_MAX_REVIEW_ROUNDS ?? "3", 10) || 3;
const NOT_OPTED_OUT_IF = '!contains(inputs.issueLabels, "no-agent")';
const RUN_REVIEWS_IF = 'needs.ci.result == "success"';
const UNSAFE = process.env.SMITHERS_UNSAFE === "1";

const SYSTEM_PROMPT = [
  "You are working inside the Smithers repository.",
  "Use jj for version control. Do not use git.",
  "Landing Requests are the review/merge unit, not pull requests.",
  "Prefer existing patterns in .smithers/workflows/batch-issues/, cmd/runner/workflow/, packages/workflow/, and poc/issue-trigger/.",
  "Read the relevant specs in docs/specs/ and CLAUDE.md before making changes.",
  "When you claim a command passed, you must have actually run it.",
  "If an external update cannot be posted because credentials or APIs are unavailable, report that honestly in the structured output.",
].join("\n");

const claude = new ClaudeCodeAgent({
  model: process.env.CLAUDE_MODEL ?? "claude-opus-4-6",
  systemPrompt: SYSTEM_PROMPT,
  addDir: [REPO_ROOT],
  dangerouslySkipPermissions: UNSAFE,
  timeoutMs: 30 * 60 * 1000,
});

const codex = new CodexAgent({
  model: process.env.CODEX_MODEL ?? "gpt-5.3-codex",
  systemPrompt: SYSTEM_PROMPT,
  addDir: [REPO_ROOT],
  yolo: UNSAFE,
  timeoutMs: 45 * 60 * 1000,
  config: { model_reasoning_effort: "high" },
});

const ReviewIssueSchema = z.object({
  severity: z.enum(["critical", "major", "minor", "nit"]),
  file: z.string(),
  line: z.number().nullable(),
  description: z.string(),
  suggestion: z.string().nullable(),
});

const ResearchArtifactSchema = z.object({
  issueIdentifier: z.string(),
  issueTitle: z.string(),
  relevantSpecs: z.array(z.string()),
  existingCode: z.array(z.string()),
  relevantPocs: z.array(z.string()),
  webFindings: z.array(z.string()),
  summary: z.string(),
  implementationHints: z.array(z.string()),
  artifactMarkdown: z.string(),
});

const PlanArtifactSchema = z.object({
  issueIdentifier: z.string(),
  summary: z.string(),
  steps: z.array(z.string()),
  risks: z.array(z.string()),
  validationPlan: z.array(z.string()),
  landingPlan: z.array(z.string()),
  artifactMarkdown: z.string(),
});

const ImplementArtifactSchema = z.object({
  issueIdentifier: z.string(),
  summary: z.string(),
  filesCreated: z.array(z.string()),
  filesModified: z.array(z.string()),
  testsAdded: z.array(z.string()),
  landingRequestCreated: z.boolean(),
  landingRequestId: z.string().nullable(),
  landingRequestUrl: z.string().nullable(),
  changeIds: z.array(z.string()),
  followUps: z.array(z.string()),
});

const CIArtifactSchema = z.object({
  issueIdentifier: z.string(),
  passed: z.boolean(),
  lintPassed: z.boolean(),
  testPassed: z.boolean(),
  buildPassed: z.boolean(),
  summary: z.string(),
  fullOutput: z.string(),
});

const ReviewArtifactSchema = z.object({
  reviewer: z.enum(["claude", "codex"]),
  approved: z.boolean(),
  issues: z.array(ReviewIssueSchema),
  summary: z.string(),
});

const NotifyArtifactSchema = z.object({
  issueIdentifier: z.string(),
  status: z.enum(["completed", "partial", "failed", "skipped"]),
  timelineUpdated: z.boolean(),
  linearUpdated: z.boolean(),
  summaryPosted: z.boolean(),
  summary: z.string(),
});

const { Workflow, Task, smithers, tables, outputs } = createSmithers(
  {
    research: ResearchArtifactSchema,
    plan: PlanArtifactSchema,
    implement: ImplementArtifactSchema,
    ci: CIArtifactSchema,
    review: ReviewArtifactSchema,
    notify: NotifyArtifactSchema,
  },
  {
    dbPath: `${process.env.HOME}/.cache/smithers/issue-pipeline.db`,
    journalMode: "DELETE",
  },
);

const IssueLabelShape = z.union([
  z.string(),
  z.object({
    name: z.string(),
  }),
]);

const IssuePipelineInputSchema = z
  .object({
    issueId: z.number().int().positive(),
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    issueBody: z.string().optional().default(""),
    issueState: z.string().optional().default("open"),
    issueAuthor: z.string().optional().default("unknown"),
    repoOwner: z.string(),
    repoName: z.string(),
    repoFullName: z.string().optional(),
    action: z.string().optional().default("opened"),
    issueLabels: z.array(z.string()).optional(),
    labels: z.array(IssueLabelShape).optional(),
  })
  .passthrough();

type IssuePipelineInput = z.infer<typeof IssuePipelineInputSchema> & {
  repoFullName: string;
  issueLabels: string[];
};

type ResearchArtifact = z.infer<typeof ResearchArtifactSchema>;
type PlanArtifact = z.infer<typeof PlanArtifactSchema>;
type ImplementArtifact = z.infer<typeof ImplementArtifactSchema>;
type CIArtifact = z.infer<typeof CIArtifactSchema>;
type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;
type NotifyArtifact = z.infer<typeof NotifyArtifactSchema>;

function normalizeIssueInput(input: unknown): IssuePipelineInput {
  const parsed = IssuePipelineInputSchema.parse(input);
  const rawLabels = parsed.issueLabels ?? parsed.labels ?? [];
  const issueLabels = rawLabels.map((label) =>
    typeof label === "string" ? label : label.name,
  );

  return {
    ...parsed,
    repoFullName: parsed.repoFullName ?? `${parsed.repoOwner}/${parsed.repoName}`,
    issueLabels,
  };
}

function issueIdentifier(issue: IssuePipelineInput): string {
  return `${issue.repoFullName}#${issue.issueNumber}`;
}

function sanitizeWorktreeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function jsonForPrompt(value: unknown): string {
  if (value == null) {
    return "null";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function reviewIssuesForPrompt(
  claudeReview: ReviewArtifact | undefined,
  codexReview: ReviewArtifact | undefined,
): string {
  const issues = [
    ...(claudeReview?.issues ?? []),
    ...(codexReview?.issues ?? []),
  ];

  if (issues.length === 0) {
    return "[]";
  }

  return jsonForPrompt(issues);
}

function reviewSummariesForPrompt(
  claudeReview: ReviewArtifact | undefined,
  codexReview: ReviewArtifact | undefined,
): string {
  const summaries = [
    claudeReview ? `Claude: ${claudeReview.summary}` : null,
    codexReview ? `Codex: ${codexReview.summary}` : null,
  ].filter(Boolean);

  return summaries.length > 0 ? summaries.join("\n\n") : "No review feedback yet.";
}

export default smithers((ctx) => {
  const issue = normalizeIssueInput(ctx.input);
  const id = issueIdentifier(issue);
  const researchOutput = ctx.latest(tables.research, "research") as ResearchArtifact | undefined;
  const planOutput = ctx.latest(tables.plan, "plan") as PlanArtifact | undefined;
  const implementOutput = ctx.latest(tables.implement, "implement") as ImplementArtifact | undefined;
  const ciOutput = ctx.latest(tables.ci, "ci") as CIArtifact | undefined;
  const claudeReview = ctx.latest(tables.review, "review-claude") as ReviewArtifact | undefined;
  const codexReview = ctx.latest(tables.review, "review-codex") as ReviewArtifact | undefined;

  const allApproved = !!claudeReview?.approved && !!codexReview?.approved;
  const worktreePath = `/tmp/smithers-issue-pipeline/${sanitizeWorktreeSegment(issue.repoFullName)}-${issue.issueNumber}`;

  const researchPrompt = `RESEARCH

Issue: ${id}
Title: ${issue.issueTitle}
Author: ${issue.issueAuthor}
State: ${issue.issueState}
Labels: ${issue.issueLabels.join(", ") || "(none)"}

Issue description:
${issue.issueBody || "(no description provided)"}

Research this issue before any planning or implementation.

Required work:
1. Search docs/specs/ for the exact product, design, engineering, and infra constraints.
2. Read CLAUDE.md and any workflow-related docs that govern AI execution.
3. Inspect the existing codebase for relevant workflow, trigger, runner, and landing-request patterns.
4. Inspect poc/ for issue-trigger and workflow orchestration references.
5. Do web research only if the repository docs are insufficient for a dependency or external tool.
6. Produce a research artifact that can be consumed directly by planning.

Return JSON with these keys:
- issueIdentifier
- issueTitle
- relevantSpecs
- existingCode
- relevantPocs
- webFindings
- summary
- implementationHints
- artifactMarkdown`;

  const planPrompt = `PLAN

Issue: ${id}
Title: ${issue.issueTitle}

Research artifact:
${jsonForPrompt(researchOutput)}

Produce the implementation plan for this issue-pipeline workflow.

The plan must:
1. Convert the research into an ordered implementation strategy.
2. Call out the trigger wiring, opt-out label behavior, and any parser/test work required.
3. Be specific about how the Implement, CI, Review, and Notify stages should behave.
4. Include validation steps and landing-request expectations.

Return JSON with these keys:
- issueIdentifier
- summary
- steps
- risks
- validationPlan
- landingPlan
- artifactMarkdown`;

  const implementPrompt = `IMPLEMENT

Issue: ${id}
Title: ${issue.issueTitle}

Plan artifact:
${jsonForPrompt(planOutput)}

Previous implementation:
${jsonForPrompt(implementOutput)}

Previous CI result:
${jsonForPrompt(ciOutput)}

Previous review issues:
${reviewIssuesForPrompt(claudeReview, codexReview)}

Previous review summaries:
${reviewSummariesForPrompt(claudeReview, codexReview)}

Implement the plan end to end inside the current worktree.

Requirements:
1. Read the relevant files before editing.
2. Address all prior CI and review failures before making new changes.
3. Create or update the Landing Request for this issue once the code is ready.
4. Use jj, not git.
5. Keep the worktree clean enough for CI and review.

Return JSON with these keys:
- issueIdentifier
- summary
- filesCreated
- filesModified
- testsAdded
- landingRequestCreated
- landingRequestId
- landingRequestUrl
- changeIds
- followUps`;

  const ciPrompt = `CI

Issue: ${id}
Title: ${issue.issueTitle}

Implementation output:
${jsonForPrompt(implementOutput)}

Run the workflow CI gate for this issue.

Required commands:
1. make lint
2. make test-go
3. make build-go
4. make build-cli

If the implementation created a Landing Request, verify that the checks are consistent with the Landing Request state.
Do not claim success unless the commands actually passed.

Return JSON with these keys:
- issueIdentifier
- passed
- lintPassed
- testPassed
- buildPassed
- summary
- fullOutput`;

  const reviewClaudePrompt = `REVIEW

Reviewer: claude
Issue: ${id}
Title: ${issue.issueTitle}

Implementation output:
${jsonForPrompt(implementOutput)}

CI output:
${jsonForPrompt(ciOutput)}

Perform a strict review of the current worktree.

Rules:
1. Read every changed file, not just the self-reported list.
2. Compare the implementation against the issue, research, and plan artifacts.
3. Treat any correctness, quality, test, reviewability, or landing-request issue as blocking.
4. Approve only when there are genuinely zero issues remaining.

Return JSON with these keys:
- reviewer
- approved
- issues
- summary

Set reviewer to "claude".`;

  const reviewCodexPrompt = `REVIEW

Reviewer: codex
Issue: ${id}
Title: ${issue.issueTitle}

Implementation output:
${jsonForPrompt(implementOutput)}

CI output:
${jsonForPrompt(ciOutput)}

Perform the strict Codex review loop for this issue.

Rules:
1. Read every changed file and verify behavior yourself.
2. Flag any correctness, maintainability, or testing gap.
3. Approve only when there are genuinely zero issues remaining.
4. Use the same bar you would use before saying LGTM on a landing request.

Return JSON with these keys:
- reviewer
- approved
- issues
- summary

Set reviewer to "codex".`;

  const reviewRounds = Math.max(
    ctx.iterationCount(tables.implement, "implement"),
    ctx.iterationCount(tables.review, "review-claude"),
    1,
  );

  const notifyPrompt = `NOTIFY

Issue: ${id}
Title: ${issue.issueTitle}

Research artifact:
${jsonForPrompt(researchOutput)}

Plan artifact:
${jsonForPrompt(planOutput)}

Implementation output:
${jsonForPrompt(implementOutput)}

CI output:
${jsonForPrompt(ciOutput)}

Claude review:
${jsonForPrompt(claudeReview)}

Codex review:
${jsonForPrompt(codexReview)}

Review rounds: ${reviewRounds}

Update the issue timeline, the linked Linear ticket, and post a final summary if the environment exposes the necessary tools or credentials.
If any of those integrations are unavailable, report false for the corresponding boolean and explain that in the summary.

Return JSON with these keys:
- issueIdentifier
- status
- timelineUpdated
- linearUpdated
- summaryPosted
- summary

Use:
- "completed" when CI passed and both reviewers approved
- "partial" when some work exists but approval was not reached
- "failed" when CI or implementation failed
- "skipped" only for the opt-out label case`;

  return (
    <Workflow name="issue-pipeline" triggers={[on.issue.opened()]}>
      <Worktree path={worktreePath} branch={`issue/${issue.issueNumber}`}>
        <Sequence>
          <Task
            id="research"
            output={outputs.research}
            agent={claude}
            timeoutMs={15 * 60 * 1000}
            if={NOT_OPTED_OUT_IF}
          >
            {researchPrompt}
          </Task>

          <Task
            id="plan"
            output={outputs.plan}
            agent={claude}
            timeoutMs={15 * 60 * 1000}
          >
            {planPrompt}
          </Task>

          <Ralph
            id="implement-review-loop"
            until={allApproved}
            maxIterations={MAX_REVIEW_ROUNDS}
            onMaxReached="return-last"
          >
            <Sequence>
              <Task
                id="implement"
                output={outputs.implement}
                agent={codex}
                timeoutMs={45 * 60 * 1000}
              >
                {implementPrompt}
              </Task>

              <Task
                id="ci"
                output={outputs.ci}
                agent={codex}
                timeoutMs={20 * 60 * 1000}
              >
                {ciPrompt}
              </Task>

              <Parallel>
                <Task
                  id="review-claude"
                  output={outputs.review}
                  agent={claude}
                  timeoutMs={15 * 60 * 1000}
                  if={RUN_REVIEWS_IF}
                >
                  {reviewClaudePrompt}
                </Task>

                <Task
                  id="review-codex"
                  output={outputs.review}
                  agent={codex}
                  timeoutMs={15 * 60 * 1000}
                  if={RUN_REVIEWS_IF}
                >
                  {reviewCodexPrompt}
                </Task>
              </Parallel>
            </Sequence>
          </Ralph>

          <Task
            id="notify"
            output={outputs.notify}
            agent={codex}
            timeoutMs={15 * 60 * 1000}
            if={NOT_OPTED_OUT_IF}
          >
            {notifyPrompt}
          </Task>
        </Sequence>
      </Worktree>
    </Workflow>
  );
});

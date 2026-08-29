import { Sequence, Parallel, MergeQueue } from "smithers";
import { IssuePipeline } from "./IssuePipeline";
import { RunCI } from "./RunCI";
import { MergeToMain } from "./MergeToMain";
import { tables } from "../smithers";
import { BATCH_SIZE, CONCURRENCY } from "../config";
import type { CIOutput } from "../schemas/ci";
import type { PlannedIssue } from "../schemas/plan";
import type { LinearIssue } from "../schemas/issue";
import type { ReportOutput } from "../schemas/report";
import type { ReviewOutput } from "../schemas/review";

interface BatchLoopProps {
  issues: LinearIssue[];
  plan: PlannedIssue[];
  ctx: any;
}

export function BatchLoop({ issues, plan, ctx }: BatchLoopProps) {

  // Build a map of Linear issues by identifier for quick lookup
  const issueMap = new Map(issues.map((i) => [i.identifier, i]));

  // Get processable issues in planned order (skip=false, has a matching Linear issue)
  const processable = plan
    .filter((p) => !p.skip)
    .map((p) => issueMap.get(p.identifier))
    .filter((i): i is LinearIssue => i != null);

  // Filter to unfinished issues (no report yet)
  const unfinished = processable.filter(
    (issue) => !ctx.latest(tables.report, `${issue.identifier}:report`),
  );

  // Take the current batch
  const currentBatch = unfinished.slice(0, BATCH_SIZE);

  if (currentBatch.length === 0) {
    return null;
  }

  // Find approved issues in this batch (both reviewers approved)
  const approvedIssues = currentBatch.filter((issue) => {
    const id = issue.identifier;
    const claudeReview = ctx.latest(tables.review, `${id}:review-claude`) as ReviewOutput | undefined;
    const codexReview = ctx.latest(tables.review, `${id}:review-codex`) as ReviewOutput | undefined;
    const report = ctx.latest(tables.report, `${id}:report`) as ReportOutput | undefined;
    return (
      report?.status === "completed" &&
      !!claudeReview?.approved &&
      !!codexReview?.approved
    );
  });

  const mergeableIssues = approvedIssues.filter((issue) => {
    const id = issue.identifier;
    const ci = ctx.latest(tables.ci, `${id}:ci`) as CIOutput | undefined;
    return !!ci?.passed;
  });

  return (
    <Sequence>
      {/* Process issues in parallel (up to CONCURRENCY limit, default 8) */}
      <Parallel maxConcurrency={CONCURRENCY}>
        {currentBatch.map((issue) => (
          <IssuePipeline key={issue.identifier} issue={issue} ctx={ctx} />
        ))}
      </Parallel>

      {/* Run CI for approved issues after batch completes */}
      {approvedIssues.length > 0 && (
        <Parallel maxConcurrency={CONCURRENCY}>
          {approvedIssues.map((issue) => (
            <RunCI key={`${issue.identifier}:ci`} issue={issue} />
          ))}
        </Parallel>
      )}

      {/* Merge approved issues to main (serialized) */}
      {mergeableIssues.length > 0 && (
        <MergeQueue>
          {mergeableIssues.map((issue) => (
            <MergeToMain key={issue.identifier} issue={issue} />
          ))}
        </MergeQueue>
      )}
    </Sequence>
  );
}

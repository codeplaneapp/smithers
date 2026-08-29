import { Task, tables, outputs } from "../smithers";
import { claude } from "../agents";
import { MAX_REVIEW_ROUNDS } from "../config";
import type { LinearIssue } from "../schemas/issue";
import type { ImplementOutput } from "../schemas/implement";
import type { ReviewOutput } from "../schemas/review";
import type { ValidateOutput } from "../schemas/validate";

interface ReportProps {
  issue: LinearIssue;
  ctx: any;
}

export function Report({ issue, ctx }: ReportProps) {
  const id = issue.identifier;

  const latestImplement = ctx.latest(tables.implement, `${id}:implement`) as ImplementOutput | undefined;
  const latestValidate = ctx.latest(tables.validate, `${id}:validate`) as ValidateOutput | undefined;
  const claudeReview = ctx.latest(tables.review, `${id}:review-claude`) as ReviewOutput | undefined;
  const codexReview = ctx.latest(tables.review, `${id}:review-codex`) as ReviewOutput | undefined;

  const allApproved = !!claudeReview?.approved && !!codexReview?.approved;
  const validationPassed = !!latestValidate?.allPassed;
  const implementIterations = ctx.iterationCount(tables.implement, `${id}:implement`);
  const reviewIterations = ctx.iterationCount(tables.review, `${id}:review-claude`);
  const hasAttempts = implementIterations > 0;
  const loopExhausted = hasAttempts && implementIterations >= MAX_REVIEW_ROUNDS && !allApproved;
  const shouldReport =
    hasAttempts && (allApproved || loopExhausted || (latestValidate != null && !validationPassed));

  const filesCreated = latestImplement?.filesCreated ?? [];
  const filesModified = latestImplement?.filesModified ?? [];
  const filesChanged = filesCreated.length + filesModified.length;
  const testsAdded = latestImplement?.testsWritten?.length ?? 0;
  const reviewRounds = Math.max(reviewIterations, implementIterations, 1);

  return (
    <Task
      id={`${id}:report`}
      output={outputs.report}
      agent={claude}
      skipIf={!shouldReport}
    >
      {`Generate a report for issue ${id} — ${issue.title}.

Implementation summary: ${latestImplement?.whatWasDone ?? "No implementation data available"}
Validation: ${latestValidate ? (latestValidate.allPassed ? "PASS" : "FAIL") : "No validation data"}
Failing summary: ${latestValidate?.failingSummary ?? "None"}

Pre-computed metrics (echo back exactly):
- issueIdentifier: ${id}
- issueTitle: ${issue.title}
- filesChanged: ${filesChanged}
- testsAdded: ${testsAdded}
- reviewRounds: ${reviewRounds}

Assess: What went well? Any struggles? Lessons learned?
Set status to "completed" if all reviewers approved, "partial" if loop exhausted without approval, "failed" if validation failed or implementation could not succeed.`}
    </Task>
  );
}

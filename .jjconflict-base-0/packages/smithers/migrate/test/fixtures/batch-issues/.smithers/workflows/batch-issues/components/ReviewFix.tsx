import { Task, tables, outputs } from "../smithers";
import { z } from "zod";
import { codex } from "../agents";
import ReviewFixPrompt from "../prompts/review-fix.mdx";
import type { LinearIssue } from "../schemas/issue";
import type { ReviewOutput } from "../schemas/review";
import type { ValidateOutput } from "../schemas/validate";

interface ReviewFixProps {
  issue: LinearIssue;
  ctx: any;
}

export function ReviewFix({ issue, ctx }: ReviewFixProps) {
  const id = issue.identifier;

  const claudeReview = ctx.latest(tables.review, `${id}:review-claude`) as ReviewOutput | undefined;
  const codexReview = ctx.latest(tables.review, `${id}:review-codex`) as ReviewOutput | undefined;

  const allApproved = !!claudeReview?.approved && !!codexReview?.approved;

  const latestValidate = ctx.latest(tables.validate, `${id}:validate`) as ValidateOutput | undefined;
  const validationPassed = !!latestValidate?.allPassed;

  const issueItem = z.object({
    severity: z.string(),
    file: z.string(),
    line: z.number().nullable(),
    description: z.string(),
    suggestion: z.string().nullable(),
  });
  const allReviewIssues = [
    ...ctx.latestArray(claudeReview?.issues, issueItem),
    ...ctx.latestArray(codexReview?.issues, issueItem),
  ];

  const allReviewFeedback = [
    claudeReview?.feedback,
    codexReview?.feedback,
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <Task
      id={`${id}:review-fix`}
      output={outputs.reviewFix}
      agent={codex}
      skipIf={!validationPassed || allApproved || allReviewIssues.length === 0}
    >
      <ReviewFixPrompt
        issueIdentifier={id}
        issueTitle={issue.title}
        issues={allReviewIssues}
        feedback={allReviewFeedback}
      />
    </Task>
  );
}

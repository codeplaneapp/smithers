import { Parallel } from "smithers";
import { Task, tables, outputs } from "../smithers";
import { claude, codex } from "../agents";
import ReviewPrompt from "../prompts/review.mdx";
import type { LinearIssue } from "../schemas/issue";
import type { ImplementOutput } from "../schemas/implement";
import type { ValidateOutput } from "../schemas/validate";

interface ReviewProps {
  issue: LinearIssue;
  ctx: any;
}

export function Review({ issue, ctx }: ReviewProps) {
  const id = issue.identifier;

  const latestImplement = ctx.latest(tables.implement, `${id}:implement`) as ImplementOutput | undefined;
  const latestValidate = ctx.latest(tables.validate, `${id}:validate`) as ValidateOutput | undefined;

  const validationPassed = !!latestValidate?.allPassed;

  if (!validationPassed) {
    return null;
  }

  const reviewProps = {
    issueIdentifier: id,
    issueTitle: issue.title,
    issueDescription: issue.description ?? "No description provided",
    filesCreated: latestImplement?.filesCreated ?? [],
    filesModified: latestImplement?.filesModified ?? [],
    validationPassed: latestValidate?.allPassed ? "PASS" : "FAIL",
    failingSummary: latestValidate?.failingSummary ?? null,
  };

  return (
    <Parallel>
      <Task
        id={`${id}:review-claude`}
        output={outputs.review}
        agent={claude}
        timeoutMs={15 * 60 * 1000}
        continueOnFail
      >
        <ReviewPrompt {...reviewProps} reviewer="claude" />
      </Task>

      <Task
        id={`${id}:review-codex`}
        output={outputs.review}
        agent={codex}
        timeoutMs={15 * 60 * 1000}
        continueOnFail
      >
        <ReviewPrompt {...reviewProps} reviewer="codex" />
      </Task>
    </Parallel>
  );
}

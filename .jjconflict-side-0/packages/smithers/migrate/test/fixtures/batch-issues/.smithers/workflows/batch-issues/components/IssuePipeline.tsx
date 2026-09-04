import { Sequence } from "smithers";
import { Worktree } from "smithers";
import { Ralph } from "smithers";
import { Research } from "./Research";
import { Implement } from "./Implement";
import { Validate } from "./Validate";
import { Review } from "./Review";
import { ReviewFix } from "./ReviewFix";
import { Report } from "./Report";
import { tables } from "../smithers";
import { MAX_REVIEW_ROUNDS } from "../config";
import type { LinearIssue } from "../schemas/issue";
import type { ReviewOutput } from "../schemas/review";
import type { ReportOutput } from "../schemas/report";

interface IssuePipelineProps {
  issue: LinearIssue;
  ctx: any;
}

export function IssuePipeline({ issue, ctx }: IssuePipelineProps) {
  const id = issue.identifier;

  const latestReport = ctx.latest(tables.report, `${id}:report`) as ReportOutput | undefined;
  const issueComplete = latestReport != null;
  const isApproved =
    !!(ctx.latest(tables.review, `${id}:review-claude`) as ReviewOutput | undefined)?.approved &&
    !!(ctx.latest(tables.review, `${id}:review-codex`) as ReviewOutput | undefined)?.approved;

  return (
    <Worktree path={`/tmp/smithers-batch/${id}`} branch={`batch/${id}`}>
      <Sequence skipIf={issueComplete}>
        <Research issue={issue} />
        <Ralph
          id={`${id}:impl-review-loop`}
          until={isApproved}
          maxIterations={MAX_REVIEW_ROUNDS}
          onMaxReached="return-last"
        >
          <Sequence>
            <Implement issue={issue} ctx={ctx} />
            <Validate issue={issue} ctx={ctx} />
            <Review issue={issue} ctx={ctx} />
            <ReviewFix issue={issue} ctx={ctx} />
          </Sequence>
        </Ralph>
        <Report issue={issue} ctx={ctx} />
      </Sequence>
    </Worktree>
  );
}

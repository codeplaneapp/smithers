import { createSmithers } from "smithers";
import { FetchIssuesOutput } from "./schemas/issue";
import { PlanOutput } from "./schemas/plan";
import { ResearchOutput } from "./schemas/research";
import { ImplementOutput } from "./schemas/implement";
import { ValidateOutput } from "./schemas/validate";
import { ReviewOutput } from "./schemas/review";
import { ReviewFixOutput } from "./schemas/reviewFix";
import { CIOutput } from "./schemas/ci";
import { MergeOutput } from "./schemas/merge";
import { ReportOutput } from "./schemas/report";
import { GeminiContextOutput } from "./schemas/geminiContext";

export const { Workflow, Task, useCtx, smithers, tables, outputs } = createSmithers({
  fetchIssues: FetchIssuesOutput,
  plan: PlanOutput,
  geminiContext: GeminiContextOutput,
  research: ResearchOutput,
  implement: ImplementOutput,
  validate: ValidateOutput,
  review: ReviewOutput,
  reviewFix: ReviewFixOutput,
  ci: CIOutput,
  merge: MergeOutput,
  report: ReportOutput,
}, { dbPath: `${process.env.HOME}/.cache/smithers/batch-issues.db`, journalMode: "DELETE" });

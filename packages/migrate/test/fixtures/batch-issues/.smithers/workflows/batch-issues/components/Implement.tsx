import { Task, tables, outputs } from "../smithers";
import { z } from "zod";
import { codex } from "../agents";
import ImplementPrompt from "../prompts/implement.mdx";
import type { LinearIssue } from "../schemas/issue";
import type { ImplementOutput } from "../schemas/implement";
import type { ValidateOutput } from "../schemas/validate";
import type { ReviewOutput } from "../schemas/review";
import type { ResearchOutput } from "../schemas/research";
import type { GeminiContextOutput } from "../schemas/geminiContext";

interface ImplementProps {
  issue: LinearIssue;
  ctx: any;
}

export function Implement({ issue, ctx }: ImplementProps) {
  const id = issue.identifier;

  const latestResearch = ctx.latest(tables.research, `${id}:research`) as ResearchOutput | undefined;
  const geminiCtx = ctx.latest(tables.geminiContext, "gemini-context") as GeminiContextOutput | undefined;
  const latestImplement = ctx.latest(tables.implement, `${id}:implement`) as ImplementOutput | undefined;
  const latestValidate = ctx.latest(tables.validate, `${id}:validate`) as ValidateOutput | undefined;

  const claudeReview = ctx.latest(tables.review, `${id}:review-claude`) as ReviewOutput | undefined;
  const codexReview = ctx.latest(tables.review, `${id}:review-codex`) as ReviewOutput | undefined;

  const issueItem = z.object({
    severity: z.string(),
    file: z.string(),
    line: z.number().nullable(),
    description: z.string(),
    suggestion: z.string().nullable(),
  });
  const reviewIssues = [
    ...ctx.latestArray(claudeReview?.issues, issueItem),
    ...ctx.latestArray(codexReview?.issues, issueItem),
  ];

  const reviewFeedback = [
    claudeReview?.feedback,
    codexReview?.feedback,
  ]
    .filter(Boolean)
    .join("\n\n");

  const reviewFixesSummary =
    reviewIssues.length > 0
      ? `Issues from review:\n${JSON.stringify(reviewIssues, null, 2)}\n\nFeedback:\n${reviewFeedback}`
      : null;

  const pocContext = latestResearch?.relevantPocs?.length
    ? `\nRelevant POCs:\n${latestResearch.relevantPocs.map((p) => `- poc/${p.pocDir}/: ${p.relevance}\n  Key files: ${p.keyFiles.join(", ")}\n  Reusable patterns: ${p.reusablePatterns}`).join("\n")}`
    : null;

  const researchParts = [
    latestResearch
      ? `Relevant specs: ${latestResearch.relevantSpecs.join(", ")}\n${latestResearch.specSummary}\n\nArchitecture notes: ${latestResearch.architectureNotes}\n\nImplementation hints: ${latestResearch.implementationHints}`
      : null,
    pocContext,
    geminiCtx?.contextForPlanning
      ? `\nGemini context:\n${geminiCtx.contextForPlanning}\n\nCurrent state: ${geminiCtx.currentState}`
      : null,
  ].filter(Boolean);
  const researchContext = researchParts.length > 0
    ? researchParts.join("\n\n---\n\n")
    : "No research available — read specs yourself";

  return (
    <Task
      id={`${id}:implement`}
      output={outputs.implement}
      agent={codex}
      timeoutMs={45 * 60 * 1000}
    >
      <ImplementPrompt
        issueIdentifier={id}
        issueTitle={issue.title}
        issueDescription={issue.description ?? "No description provided"}
        researchContext={researchContext}
        previousImplementation={
          latestImplement
            ? {
                whatWasDone: latestImplement.whatWasDone ?? null,
                testOutput: latestImplement.testOutput ?? null,
              }
            : null
        }
        reviewFixes={reviewFixesSummary}
        validationFeedback={
          latestValidate
            ? {
                allPassed: latestValidate.allPassed ?? null,
                failingSummary: latestValidate.failingSummary ?? null,
              }
            : null
        }
      />
    </Task>
  );
}

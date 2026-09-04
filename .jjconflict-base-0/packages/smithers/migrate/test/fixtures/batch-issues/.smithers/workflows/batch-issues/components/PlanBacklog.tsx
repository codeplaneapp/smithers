import { Sequence, Parallel } from "smithers";
import { Task, outputs } from "../smithers";
import { claude, codex } from "../agents";
import { GeminiContext } from "./GeminiContext";
import ResearchPrompt from "../prompts/research.mdx";
import PlanPrompt from "../prompts/plan.mdx";
import type { LinearIssue } from "../schemas/issue";
import type { ResearchOutput } from "../schemas/research";
import type { GeminiContextOutput } from "../schemas/geminiContext";

interface PlanBacklogProps {
  issues: LinearIssue[];
  ctx: any;
  geminiOutput?: GeminiContextOutput;
  researchOutput?: ResearchOutput;
}

export function PlanBacklog({ issues, ctx, geminiOutput, researchOutput }: PlanBacklogProps) {
  // Combine Gemini context + Claude research for the planning agent
  const combinedContext = [
    geminiOutput?.contextForPlanning ?? "",
    researchOutput?.specSummary ?? "",
    geminiOutput?.currentState ? `\nCurrent project state: ${geminiOutput.currentState}` : "",
    geminiOutput?.blockers?.length
      ? `\nKnown blockers:\n${geminiOutput.blockers.map((b) => `- ${b}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const hasContext = !!geminiOutput || !!researchOutput;

  return (
    <Sequence>
      {/* Phase 1: Gemini extracts context from all specs + commit history,
          Claude reads specs for research — run in parallel */}
      <Parallel>
        <GeminiContext />
        <Task id="plan:research" output={outputs.research} agent={claude}>
          <ResearchPrompt
            issueIdentifier="BACKLOG"
            issueTitle="Full backlog analysis"
            issueDescription={`Analyze the Smithers project specs to prepare for prioritizing ${issues.length} backlog issues. Understand the architecture, current state, and key patterns.`}
          />
        </Task>
      </Parallel>

      {/* Phase 2: Codex orders the issues using combined Gemini + Claude context */}
      <Task id="plan:order" output={outputs.plan} agent={codex} skipIf={!hasContext}>
        <PlanPrompt
          issueCount={issues.length}
          researchSummary={combinedContext || "No research available"}
          issuesJson={JSON.stringify(issues, null, 2)}
        />
      </Task>
    </Sequence>
  );
}

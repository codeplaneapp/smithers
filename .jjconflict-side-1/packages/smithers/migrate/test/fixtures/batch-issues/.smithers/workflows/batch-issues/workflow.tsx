import { Sequence, Branch } from "smithers";
import { FetchIssues, PlanBacklog, BatchLoop } from "./components";
import { LinearIssue } from "./schemas/issue";
import { PlannedIssue } from "./schemas/plan";
import { Workflow, smithers, tables } from "./smithers";

export default smithers((ctx) => {
  // Phase 1: Fetch issues from Linear
  const fetchOutput = ctx.latest(tables.fetchIssues, "fetch-issues");
  const issues = ctx.latestArray(fetchOutput?.issues, LinearIssue);

  // Phase 2: Plan the backlog (research + ordering)
  const planOutput = ctx.latest(tables.plan, "plan:order");
  const plan = ctx.latestArray(planOutput?.orderedIssues, PlannedIssue);

  const needsFetch = issues.length === 0;
  const needsPlan = issues.length > 0 && plan.length === 0;
  const readyToProcess = plan.length > 0;

  // Get Gemini and research outputs for PlanBacklog
  const geminiOutput = ctx.latest(tables.geminiContext, "gemini-context");
  const researchOutput = ctx.latest(tables.research, "plan:research");

  return (
    <Workflow name="batch-issues">
      <Sequence>
        {/* Fetch all backlog issues from Linear */}
        <Branch if={needsFetch} then={<FetchIssues />} />

        {/* Research specs + order issues by priority */}
        {needsPlan && (
          <PlanBacklog
            issues={issues as LinearIssue[]}
            ctx={ctx}
            geminiOutput={geminiOutput}
            researchOutput={researchOutput}
          />
        )}

        {/* Process batches of 10: Parallel worktrees → CI → MergeQueue */}
        {readyToProcess && (
          <BatchLoop
            issues={issues as LinearIssue[]}
            plan={plan as PlannedIssue[]}
            ctx={ctx}
          />
        )}
      </Sequence>
    </Workflow>
  );
});

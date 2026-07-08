// smithers-source: bespoke
// smithers-display-name: Issue 491 — review cloud /api/plan
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { implementer, panelists } from "../components/roles";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewSynthesisSchema, reviewGate } from "../components/Review";

// The hosted walkthrough lifecycle (#491) is already mostly on main: D1
// metadata rows, per-repo history, DELETE, per-session publish limits, the CSP
// sandbox + branded 404, and a landing page. The one deliverable the issue
// names that does NOT exist yet is `GET /api/plan` — plan/quota visibility for
// the authenticated repo. This workflow implements exactly that, TDD-first.

const inputSchema = z.object({
  spec: z.string().default(
    `Add a \`GET /api/plan\` endpoint to the smithers review cloud worker (apps/review) that gives the
authenticated caller plan and quota visibility for a repo. This is the last un-done item of issue #491.

TDD — write the failing test FIRST, watch it go red, then implement until green.

TEST (new file apps/review/tests/server/handlePlan.test.ts, mirror the style of
apps/review/tests/server/handleWalkthroughs.test.ts — use createReviewWorker, buildTestEnv, sha256Hex,
seed rows directly via env.DB.prepare). Cover:
  - A session-authenticated GET /api/plan (Authorization: Bearer <session token>) for a REGISTERED repo
    returns 200 with a JSON body exposing the plan (mode, quiz, prsPerMonth, spendCapUsd) and the
    month-to-date quota (month, prsUsed, prsPerMonth, monthlyCapUsd, monthlySpendUsd). Seed a repos row,
    some reviewed_prs rows in the current month, and a usage_events row so prsUsed and monthlySpendUsd
    are non-zero and assertable. monthlyCapUsd must equal prsPerMonth * spendCapUsd.
  - No credential -> 401.
  - A session whose repo is NOT registered (no repos row) -> 404.
  - An srk_ api-key requesting ?repo=<a repo it does NOT own> -> 403.

IMPLEMENTATION:
  - New file apps/review/src/server/plan/handlePlan.ts exporting \`handlePlan(request, env, url, now)\`.
    Authenticate with authenticateProxyRequest (../proxy/authenticateProxyRequest.ts) -> 401 when null.
    Resolve the target repo from url.searchParams.get("repo"); when absent and the credential is a
    session, default to the session's repo. Reuse the canAccessRepo shape from handleWalkthroughs
    (session: repo === credential.repo; api-key: credential.repos.includes(repo)) -> 403 when denied.
    Look the repo up with lookupRepo (../sessions/lookupRepo.ts) -> 404 "repo not registered" when null.
    Compute quota: prsUsed = COUNT(*) of reviewed_prs for (repo, monthKey(now)); monthlySpendUsd via
    repoMonthlySpendUsd(../repoMonthlySpendUsd.ts); monthlyCapUsd via repoMonthlyCapUsd(../repoMonthlyCapUsd.ts).
    Return Response.json({ repo, plan: { mode, quiz, prsPerMonth, spendCapUsd }, quota: { month, prsUsed,
    prsPerMonth, monthlyCapUsd, monthlySpendUsd } }). Reuse jsonError for the error responses.
  - Wire the route into apps/review/src/server/worker.ts (after the admin routes, before the
    walkthroughs block): GET /api/plan -> handlePlan(request, env, url, deps.now()). It must sit BELOW
    the ensureSchema / env.DB guard since it reads D1.

CONSTRAINTS: minimal, idiomatic, no new dependencies, no unrelated refactors, follow existing file
conventions exactly (one export per file, explicit interfaces for row shapes, .ts import extensions).
VERIFY by running: pnpm -C apps/review test handlePlan (and the full apps/review suite must stay green).`,
  ),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  plan: z.object({
    plan: z.string().describe("the concrete implementation plan for GET /api/plan"),
    testPath: z.string().default("apps/review/tests/server/handlePlan.test.ts"),
  }),
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
});

export default smithers((ctx) => {
  const spec = ctx.input.spec ?? "";
  const plan = ctx.outputMaybe("plan", { nodeId: "p491:plan" });

  const validate = ctx.outputMaybe("validate", { nodeId: "p491:impl:validate" });
  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const gate = reviewGate(ctx, "p491:impl:review-moderator");
  const done = validationPassed && gate.approved;

  const feedbackParts: string[] = [];
  if (validate && !validationPassed && validate.failingSummary) {
    feedbackParts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  if (gate.feedback) {
    feedbackParts.push(`REVIEW PANEL REJECTED:\n${gate.feedback}`);
  }
  const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null;

  const implementPrompt = plan
    ? `${spec}\n\n---\nAPPROVED PLAN:\n${plan.plan}`
    : spec;

  return (
    <Workflow name="issue-491-review-cloud-hosted-walkthrough-lifecycl">
      <UI entry="../ui/implement.tsx" title={"Issue 491 — /api/plan"} />
      <Sequence>
        <Task id="p491:plan" output={outputs.plan} agent={agents.planning}>
          {`You are planning a small, well-scoped fix. Read the spec, then read the referenced files in
apps/review/src/server (worker.ts, walkthroughs/handleWalkthroughs.ts, proxy/authenticateProxyRequest.ts,
sessions/lookupRepo.ts, repoMonthlySpendUsd.ts, repoMonthlyCapUsd.ts, monthKey.ts) and the existing test
tests/server/handleWalkthroughs.test.ts. Produce a concrete, minimal implementation plan and the test path.

SPEC:
${spec}`}
        </Task>

        {plan ? (
          <ValidationLoop
            idPrefix="p491:impl"
            prompt={implementPrompt}
            implementAgents={implementer}
            validateAgents={agents.cheapFast}
            reviewAgents={panelists}
            synthesizeReview
            feedback={feedback}
            done={done}
            maxIterations={3}
          />
        ) : null}
      </Sequence>
    </Workflow>
  );
});

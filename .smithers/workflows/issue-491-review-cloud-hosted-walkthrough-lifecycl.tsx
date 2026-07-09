// smithers-source: bespoke
// smithers-display-name: Issue 491 — review cloud landing onboarding
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod/v4";
import { implementer, panelists, synthesizer, validator } from "../components/roles";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";

// Codex role split: Sol plans/reviews, Luna implements, Terra validates.
// The shared role chains retain Claude/Gemini as no-Codex fallbacks.

// The hosted walkthrough lifecycle (#491) is almost entirely on main already:
// D1 metadata rows on publish, per-repo history (GET /api/walkthroughs?repo=),
// DELETE /api/walkthroughs/<id>, per-session publish limits, and the serving
// hardening (CSP `sandbox allow-scripts` + branded 404). The `GET /api/plan`
// plan/quota endpoint has also landed (handlePlan.ts + handlePlan.test.ts). The
// one deliverable the issue still names that is NOT done is the "Landing page"
// bullet: `landingPage.ts` is a bare stub that does not onboard. This workflow
// finishes #491 by making the landing page onboard — TDD-first.

const inputSchema = z.object({
  spec: z.string().default(
    `Finish issue #491 by making the smithers review cloud landing page (apps/review) actually onboard a
new user. Today apps/review/src/server/landingPage.ts is a bare stub: it names the product and shows one
publish command, but it does NOT explain how a repo gets registered, does NOT point at plan/quota
visibility (the \`GET /api/plan\` endpoint that now exists), and shows no example of what a published
walkthrough looks like. The issue's "Landing page" bullet asks it to onboard: what the product is, a real
walkthrough example, registration instructions, and plan/quota visibility (GET /api/plan).

TDD — write the failing test FIRST, watch it go red, then implement until green.

TEST (new file apps/review/tests/server/landingPage.test.ts, mirror the style of
apps/review/tests/server/workerMissingDb.test.ts — use createReviewWorker with fixture deps and
buildTestEnv for the env). Cover, by asserting on the GET / response body text:
  - GET / returns 200 with content-type text/html; charset=utf-8 (it already does — keep this assertion).
  - The body onboards on registration: it must reference the repo registration / access path so a new
    user knows how to get set up (assert it mentions the GitHub Action / OIDC onboarding, e.g. contains
    the substring "/api/sessions" or a "register"/"onboard" instruction — pick wording that matches the
    implementation).
  - The body surfaces plan/quota visibility: assert it contains the substring "/api/plan".
  - The body shows a real walkthrough example: assert it references the published walkthrough link shape,
    i.e. contains the substring "/w/".
  - Keep the existing product description and publish command visible (assert it still contains
    "--publish" or the publish command).
Every asserted substring MUST be absent from the current landingPage.ts so the test genuinely goes red
before the change — confirm that by running the test before editing landingPage.ts.

IMPLEMENTATION:
  - Edit ONLY apps/review/src/server/landingPage.ts. It exports \`const landingPage\` (a full HTML string
    that already imports workflowUiThemeCss and has a <style> block). Extend the <main> content so it
    onboards: (1) a one-line "what it is", (2) a short "publish" example (keep the existing
    \`smithers-review ... --publish\` command) and show the resulting unlisted link shape (\`/w/<id>\`),
    (3) "get access / register" instructions describing the GitHub Action + OIDC session flow (the
    action mints a session at POST /api/sessions; an operator registers the repo), and (4) a
    "check your plan & quota" note pointing at \`GET /api/plan\`. Keep it a single static HTML string —
    no new imports, no new dependencies, no server logic. Reuse the existing CSS classes / theme vars.
  - Do NOT change worker.ts routing or any other file.

CONSTRAINTS: minimal, idiomatic, no new dependencies, no unrelated refactors, one export per file,
keep the landing page a pure static string so it still serves without a DB (workerMissingDb.test.ts must
stay green). VERIFY by running: pnpm -C apps/review test landingPage (and the full apps/review suite must
stay green).`,
  ),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  plan: z.object({
    plan: z.string().describe("the concrete implementation plan for the landing-page onboarding"),
    testPath: z.string().default("apps/review/tests/server/landingPage.test.ts"),
  }),
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
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
      <UI entry="../ui/implement.tsx" title={"Issue 491 — landing onboarding"} />
      <Sequence>
        <Task id="p491:plan" output={outputs.plan} agent={synthesizer}>
          {`You are planning a small, well-scoped fix. Read the spec, then read the referenced files in
apps/review/src/server (landingPage.ts, worker.ts, plan/handlePlan.ts, sessions/handleSessions.ts) and the
existing test tests/server/workerMissingDb.test.ts. Produce a concrete, minimal implementation plan and
the test path.

SPEC:
${spec}`}
        </Task>

        {plan ? (
          <ValidationLoop
            idPrefix="p491:impl"
            prompt={implementPrompt}
            implementAgents={implementer}
            validateAgents={validator}
            reviewAgents={panelists}
            synthesizeReview
            reviewModerator={synthesizer}
            feedback={feedback}
            done={done}
            maxIterations={3}
          />
        ) : null}
      </Sequence>
    </Workflow>
  );
});

// smithers-source: bespoke
// smithers-display-name: Issue 522 — composite components deps wiring
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod/v4";
import { implementer, panelists, synthesizer, validator } from "../components/roles";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";

// Issue #522 (umbrella): seven built-in composite components pass `needs`
// (cache-key context only) WITHOUT `deps`, so downstream agents never receive
// upstream outputs in their prompts — they run blind. The Panel moderator had
// the identical defect and was fixed with a `deps` + `depsOptional` map; the
// same treatment applies to each component below. Two components (ScanFixVerify,
// Debate) also still hardcode `until: false` with a comment describing runtime
// behavior that does not exist. (ReviewLoop/Optimizer/Supervisor already derive
// `until` from ctx on main — only their deps wiring is missing.) TDD-first.

const inputSchema = z.object({
  spec: z.string().default(
    `Fix GitHub issue #522 in packages/components: seven composite components pass \`needs\` without
\`deps\`, so downstream agents run blind. Follow the PANEL PRECEDENT exactly
(packages/components/src/components/Panel.js): a \`deps\` map with the SAME keys as \`needs\`
(needs remaps key -> nodeId), \`depsOptional: true\`, and a FUNCTION children prop
\`(resolvedDeps) => promptString\` that folds each resolved upstream output into the prompt.

HOW DEPS WORK (packages/components/src/components/Task.js): \`needs[key]\` supplies the upstream
nodeId; \`deps[key]\` supplies the OutputTarget (table name or zod schema). resolveDeps calls
\`ctx.outputMaybe(deps[key], { nodeId: needs[key] ?? key })\`. With \`depsOptional: true\`, an
unresolved key is simply omitted (the task still renders) instead of deferring forever; without it
the task defers until every dep resolves. When children is a function AND (agent || deps) it is
called with the resolved-deps object and its return value becomes the prompt text.

TDD — write the FAILING test FIRST, watch it go red, then implement until green. New test file
packages/components/tests/composite-deps-wiring.test.jsx, mirroring the render harness in
packages/components/tests/ai-orchestration-components-unit.test.jsx (SmithersRenderer + SmithersCtx
with a seeded \`outputs\` map; find the downstream task via graph.tasks.find(t => t.nodeId === ...)
and assert its \`.prompt\` CONTAINS the seeded upstream output). Each assertion must be RED on the
current code (static prompt, no deps -> upstream text absent) and GREEN after the fix. Cover every
component below. outputRow helper: { runId, nodeId, iteration: 0, ...payload } seeded under the
task's output-table key.

PER-COMPONENT CHANGES (minimal, idiomatic, Panel-style):

1. ReviewLoop (packages/components/src/components/ReviewLoop.js)
   - Reviewer task: keep \`needs: { produced: produceId }\`; ADD \`deps: { produced: produceOutput }\`
     and a function child \`(d) => "Review the produced work and decide whether to approve." + the
     produced output text when d.produced is present\`. So the reviewer's prompt actually contains
     the produced work.
   - Producer feedback: the component already computes \`latestReview = ctx?.latest?.(reviewOutput,
     reviewId)\`. Fold \`latestReview\` feedback into the PRODUCER's children on iterations > 0 (the
     docstring already promises "The producer receives the reviewer's feedback on subsequent
     iterations"). On iteration 0 (no review yet) the producer prompt stays the plain \`children\`.
   - \`until: approved\` already correct — do not change it.

2. ScanFixVerify (packages/components/src/components/ScanFixVerify.js)
   - Replace hardcoded \`until: false\` with a value derived from the verify output row, exactly like
     Poller.js: read \`ctx?.outputMaybe(props.verifyOutput, { nodeId: \\\`\${prefix}-verify\\\`, iteration })\`
     and set \`until = verifyRow?.resolved === true\`. Remove the misleading "Re-evaluated at render
     time via reactive context" comment. (This component uses \`dependsOn\`, not needs/deps, so no
     deps map is required — the until fix is the whole change.)

3. Debate (packages/components/src/components/Debate.js)
   - Judge task: keep the \`needs\` map (proposer + opponent nodeIds); ADD a \`deps\` map with the SAME
     keys mapping each to \`argumentOutput\`, \`depsOptional: true\`, and a function child that folds the
     resolved proposer/opponent arguments into the verdict prompt. The prompt must still contain the
     phrase "render a verdict" and the topic.
   - Replace the misleading \`until: false\` comment (which claims nonexistent reactive iteration
     control) with an honest one: a debate runs all \`rounds\` — there is no early-exit signal, so
     \`until\` stays false and \`maxIterations\` caps the rounds. (Optionally fold prior-round arguments
     into each round's proposer/opponent prompt via ctx.latest; keep it simple.)

4. GatherAndSynthesize (packages/components/src/components/GatherAndSynthesize.js)
   - Synthesis task: keep the \`needs\` map (name -> gather task id); ADD \`deps\` keyed per source
     (\`deps[name] = sources[name].output ?? gatherOutput\`), \`depsOptional: true\`, and fold the
     resolved gathered data into the DEFAULT synthesis prompt via a function child. PRESERVE the
     existing prompt precedence and the existing exact-match unit test
     (ai-orchestration-components-unit.test.jsx): when NO gather outputs are resolved the default
     prompt must still be exactly "Synthesize the gathered data from sources: <names>." and explicit
     \`children\`/\`synthesisPrompt\` overrides still win verbatim. Only the DEFAULT path folds deps.

5. Optimizer (packages/components/src/components/Optimizer.js)
   - Agent evaluator task: keep \`needs: { candidate: generateId }\`; ADD \`deps: { candidate:
     generateOutput }\` and a function child folding the candidate into "Evaluate the generated
     candidate and provide a score." Do NOT add deps to the compute-function evaluator branch.
   - Generator feedback: fold the previous evaluation's score/feedback (already available via
     \`ctx?.latest?.(evaluateOutput, evaluateId)\`) into the GENERATOR's children on iterations > 0, per
     the docstring "Each iteration receives the previous score and feedback to guide improvement."
   - \`until: converged\` already correct — do not change it.

6. Supervisor (packages/components/src/components/Supervisor.js)
   - Workers: keep \`needs: { plan }\`; ADD \`deps: { plan: props.planOutput }\`, \`depsOptional: true\`,
     and fold the plan into each worker's prompt ("Refer to the plan..." + plan text).
   - Review task: it must SEE worker outputs. Add worker nodeIds to its \`needs\` and a matching \`deps\`
     map (each -> props.workerOutput) with \`depsOptional: true\` (workers use continueOnFail), plus the
     plan; fold worker results + plan into the review prompt. Keep the review contract text ("Set
     allDone to true...", "retriable[]").
   - Final task: keep \`needs: { review, plan }\`; ADD a matching \`deps\` map (review -> reviewOutput,
     plan -> planOutput), \`depsOptional: true\`, and fold review + plan into the summary prompt.
   - \`until: allDone\` already correct — do not change it. (Update the existing unit-test assertions
     in ai-orchestration-components-unit.test.jsx that assert review/final \`needs\` shape ONLY if you
     changed those needs maps — keep the change minimal and update the codified assertion to match.)

7. ContentPipeline (packages/components/src/components/ContentPipeline.js)
   - Each non-first stage: keep \`needs: { previous: prevStage.id }\`; ADD \`deps: { previous:
     prevStage.output }\` and a function child that folds the resolved previous-stage output into
     "Continue from the previous stage's output. Perform: <label>". So each stage actually receives
     the prior stage's work.

CONSTRAINTS: minimal and idiomatic, no new dependencies, no unrelated refactors, follow the Panel
precedent and existing file conventions exactly (these are compiled .js sources — keep them plain
JS, React.createElement style, matching the surrounding code). The ENTIRE existing
packages/components test suite must stay green — update ONLY the specific existing assertions that
literally encoded the old blind behavior or the removed misleading comments.

VERIFY by running: \`pnpm -C packages/components test composite-deps-wiring\` (the new test), then the
FULL \`pnpm -C packages/components test\` must stay green, then \`pnpm typecheck\` at the repo root.`,
  ),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  plan: z.object({
    plan: z.string().describe("the concrete per-component implementation plan following the Panel precedent"),
    testPath: z.string().default("packages/components/tests/composite-deps-wiring.test.jsx"),
  }),
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  reviewOutput: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
});

export default smithers((ctx) => {
  const spec = ctx.input.spec ?? "";
  const plan = ctx.outputMaybe("plan", { nodeId: "p522:plan" });

  const validate = ctx.outputMaybe("validate", { nodeId: "p522:impl:validate" });
  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const gate = reviewGate(ctx, "p522:impl:review-moderator");
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
    <Workflow name="issue-522-components-seven-composite-components-ar">
      <UI entry="../ui/implement.tsx" title={"Issue 522 — composite deps wiring"} />
      <Sequence>
        <Task id="p522:plan" output={outputs.plan} agent={synthesizer}>
          {`You are planning a well-scoped, TDD-first fix for issue #522. Read the spec, then read the
Panel precedent (packages/components/src/components/Panel.js), the deps machinery
(packages/components/src/components/Task.js resolveDeps/deriveDepNodeIds), the Poller until pattern
(packages/components/src/components/Poller.js), the seven target components, and the existing render
harness + assertions in packages/components/tests/ai-orchestration-components-unit.test.jsx. Produce
a concrete, minimal per-component implementation plan (deps map + function children per component,
the two until fixes, and which existing test assertions must be updated) and the test path.

SPEC:
${spec}`}
        </Task>

        {plan ? (
          <ValidationLoop
            idPrefix="p522:impl"
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

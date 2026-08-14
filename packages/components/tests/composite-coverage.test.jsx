/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import {
  ApprovalGate,
  Aspects,
  CheckSuite,
  ClassifyAndRoute,
  ContentPipeline,
  Debate,
  DecisionTable,
  DriftDetector,
  EscalationChain,
  GatherAndSynthesize,
  HumanTask,
  Optimizer,
  Panel,
  ReviewLoop,
  Runbook,
  Sandbox,
  ScanFixVerify,
  Subflow,
  SuperSmithers,
  Supervisor,
  Task,
} from "../src/components/index.js";
import { AspectContext, createAccumulator } from "../src/aspects/AspectContext.js";
import { zodSchemaToJsonExample } from "../src/zod-to-example.js";
import { SmithersRenderer } from "@smthrs/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smthrs/react-reconciler/context";

const agent = { id: "agent", generate: async () => ({ text: "ok" }) };
const otherAgent = { id: "other", generate: async () => ({ text: "ok" }) };

async function render(el) {
  const renderer = new SmithersRenderer();
  return renderer.render(el);
}

async function renderWithOutputs(el, outputs) {
  const ctx = new SmithersCtx({
    runId: "test-run",
    iteration: 0,
    input: {},
    outputs,
  });
  return render(<SmithersContext.Provider value={ctx}>{el}</SmithersContext.Provider>);
}

function childArray(element) {
  return React.Children.toArray(element.props.children);
}

describe("composite component expansion coverage", () => {
  test("EscalationChain expands levels, checks, fallback approval, and skipIf", async () => {
    expect(EscalationChain({ skipIf: true, levels: [] })).toBeNull();

    const result = await render(
      <EscalationChain
        id="incident"
        levels={[
          { agent, output: "level_out", label: "First" },
          { agent: otherAgent, output: "level_out", label: "Second" },
        ]}
        escalationOutput="escalation_out"
        humanFallback
        humanRequest={{ title: "Human review", summary: "Escalate" }}
      >
        triage incident
      </EscalationChain>,
    );

    const ids = result.tasks.map((task) => task.nodeId);
    expect(ids).toEqual(["incident-level-0", "incident-check-0", "incident-level-1", "incident-human-fallback"]);
    expect(result.tasks[1].computeFn()).toEqual({
      escalated: true,
      fromLevel: 0,
      toLevel: 1,
    });
    expect(result.tasks[3].needsApproval).toBe(true);
  });

  test("HumanTask renders approval-backed task metadata and schema settings", async () => {
    expect(HumanTask({ skipIf: true, id: "human" })).toBeNull();

    const output = z.object({ answer: z.string() });
    const result = await render(
      <HumanTask
        id="human-answer"
        output={output}
        prompt={<p>Provide an answer</p>}
        maxAttempts={4}
        async
        meta={{ owner: "ops" }}
      />,
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].nodeId).toBe("human-answer");
    expect(result.tasks[0].kind).toBe("human");
    expect(result.tasks[0].needsApproval).toBe(true);
    expect(result.tasks[0].waitAsync).toBe(true);
    expect(result.tasks[0].retries).toBe(3);
    expect(result.tasks[0].meta).toMatchObject({
      humanTask: true,
      maxAttempts: 4,
      owner: "ops",
    });
    expect(result.tasks[0].meta.prompt).toContain("Provide an answer");
  });

  test("HumanTask with non-finite maxAttempts fails extraction loudly instead of retrying forever", async () => {
    await expect(
      render(
        <HumanTask id="human-unbounded" output="human_out" prompt="Approve?" maxAttempts={Number.POSITIVE_INFINITY} />,
      ),
    ).rejects.toThrow('<HumanTask id="human-unbounded"> maxAttempts must be finite.');
  });

  test("Runbook emits safe steps plus risky and critical approval gates", async () => {
    expect(Runbook({ skipIf: true, steps: [] })).toBeNull();

    const result = await render(
      <Runbook
        id="deploy"
        defaultAgent={agent}
        stepOutput="step_out"
        onDeny="skip"
        approvalRequest={{
          title: "Approve step",
          summary: "Approval required",
          metadata: { runbook: "deploy" },
        }}
        steps={[
          { id: "lint", risk: "safe", command: "pnpm lint" },
          { id: "migrate", risk: "risky", command: "pnpm migrate" },
          { id: "cutover", risk: "critical" },
        ]}
      />,
    );

    const ids = result.tasks.map((task) => task.nodeId);
    expect(ids).toEqual([
      "deploy-lint",
      "deploy-migrate-approval",
      "deploy-migrate",
      "deploy-cutover-approval",
      "deploy-cutover",
    ]);
    expect(result.tasks[1].needsApproval).toBe(true);
    expect(result.tasks[1].approvalOnDeny).toBe("skip");
    expect(result.tasks[3].meta).toMatchObject({
      risk: "critical",
      elevated: true,
      runbook: "deploy",
    });
  });

  test("ClassifyAndRoute routes config and direct agent categories", async () => {
    expect(ClassifyAndRoute({ skipIf: true })).toBeNull();

    const result = await render(
      <ClassifyAndRoute
        id="router"
        items={{ id: "one" }}
        classifierAgent={agent}
        classifierOutput="class_out"
        routeOutput="route_out"
        categories={{
          bug: {
            agent,
            output: "bug_out",
            prompt: (classification) => `Bug ${classification.itemId}`,
          },
          docs: otherAgent,
        }}
        classificationResult={{
          classifications: [
            { itemId: "A", category: "bug" },
            { itemId: "B", category: "docs" },
            { itemId: "C", category: "missing" },
          ],
        }}
      />,
    );

    expect(result.tasks.map((task) => task.nodeId)).toEqual(["router-classify", "router-route-A", "router-route-B"]);
    expect(result.tasks[1].outputTableName).toBe("bug_out");
    expect(result.tasks[2].outputTableName).toBe("route_out");
    expect(result.tasks[1].prompt).toBe("Bug A");
  });

  test("GatherAndSynthesize builds gather tasks and synthesis needs", async () => {
    expect(GatherAndSynthesize({ skipIf: true })).toBeNull();

    const result = await renderWithOutputs(
      <GatherAndSynthesize
        id="research"
        sources={{
          web: { agent, prompt: "search web" },
          code: { agent: otherAgent, output: "code_out", children: "scan code" },
        }}
        synthesizer={agent}
        gatherOutput="gather_out"
        synthesisOutput="synthesis_out"
        gatheredResults={{ web: { hits: 2 }, code: { files: 3 } }}
        maxConcurrency={2}
      />,
      {},
    );

    expect(result.tasks.map((task) => task.nodeId)).toEqual([
      "research-gather-web",
      "research-gather-code",
      "research-synthesize",
    ]);
    expect(result.tasks[0].parallelMaxConcurrency).toBe(2);
    expect(result.tasks[2].needs).toEqual({
      web: "research-gather-web",
      code: "research-gather-code",
    });
    expect(result.tasks[2].prompt).toContain("## web");
  });

  test("CheckSuite handles array and object checks with a compute verdict", async () => {
    expect(CheckSuite({ skipIf: true })).toBeNull();

    const arrayResult = await render(
      <CheckSuite
        id="checks"
        strategy="majority"
        verdictOutput="verdict_out"
        checks={[
          { id: "types", label: "Types", command: "pnpm typecheck" },
          { id: "tests", agent, label: "Tests" },
        ]}
      />,
    );
    expect(arrayResult.tasks.map((task) => task.nodeId)).toEqual(["checks-types", "checks-tests", "checks-verdict"]);
    const verdict = arrayResult.tasks[2];
    expect(typeof verdict.computeFn).toBe("function");
    expect(verdict.staticPayload).toBeUndefined();
    expect(verdict.agent).toBeUndefined();
    expect(new Set(verdict.dependsOn)).toEqual(new Set(["checks-types", "checks-tests"]));

    const objectResult = await render(
      <CheckSuite
        id="quick"
        strategy="any-pass"
        verdictOutput="verdict_out"
        checks={{ lint: { command: "pnpm lint" } }}
      />,
    );
    expect(typeof objectResult.tasks[1].computeFn).toBe("function");
    expect(objectResult.tasks[1].dependsOn).toEqual(["quick-lint"]);
  });

  test("Panel covers direct agent/config panelists and moderation strategies", async () => {
    expect(Panel({ skipIf: true })).toBeNull();

    await expect(
      render(
        <Panel
          id="empty"
          panelists={[]}
          moderator={agent}
          panelistOutput="panel_out"
          moderatorOutput="moderator_out"
          strategy="synthesize"
        >
          review
        </Panel>,
      ),
    ).rejects.toThrow(/panelists.*at least one/i);

    const voteResult = await renderWithOutputs(
      <Panel
        id="panel"
        panelists={[agent, { agent: otherAgent, role: "security" }]}
        moderator={agent}
        panelistOutput="panel_out"
        moderatorOutput="moderator_out"
        strategy="vote"
        minAgree={2}
      >
        review this
      </Panel>,
      {},
    );
    expect(voteResult.tasks.map((task) => task.nodeId)).toEqual([
      "panel-panelist-0",
      "panel-security",
      "panel-moderator",
    ]);
    expect(voteResult.tasks[2].prompt).toContain("Strategy: VOTE");

    const consensusResult = await renderWithOutputs(
      <Panel
        id="consensus"
        panelists={[{ agent, label: "one" }]}
        moderator={otherAgent}
        panelistOutput="panel_out"
        moderatorOutput="moderator_out"
        strategy="consensus"
      />,
      {},
    );
    expect(consensusResult.tasks[1].prompt).toContain("Strategy: CONSENSUS");
  });

  test("Panel supports failover-chain panelists and per-task options", async () => {
    const result = await renderWithOutputs(
      <Panel
        id="rp"
        panelists={[[agent, otherAgent], agent]}
        moderator={[otherAgent, agent]}
        panelistOutput="panel_out"
        moderatorOutput="moderator_out"
        strategy="synthesize"
        panelistTaskProps={{ continueOnFail: true, timeoutMs: 1000, heartbeatTimeoutMs: 500 }}
        moderatorTaskProps={{ timeoutMs: 2000 }}
      >
        review this
      </Panel>,
      {},
    );
    expect(result.tasks.map((task) => task.nodeId)).toEqual(["rp-panelist-0", "rp-panelist-1", "rp-moderator"]);
    // A failover-chain entry becomes one panelist whose agent IS the chain.
    expect(result.tasks[0].agent).toEqual([agent, otherAgent]);
    expect(result.tasks[1].agent).toBe(agent);
    // A failover-chain moderator passes the chain through to the moderator Task,
    // which runs it as failover (e.g. Codex-first, Opus fallback).
    expect(result.tasks[2].agent).toEqual([otherAgent, agent]);
    // panelistTaskProps apply to every panelist task; moderatorTaskProps to the moderator.
    expect(result.tasks[0].continueOnFail).toBe(true);
    expect(result.tasks[0].timeoutMs).toBe(1000);
    expect(result.tasks[0].heartbeatTimeoutMs).toBe(500);
    expect(result.tasks[1].continueOnFail).toBe(true);
    expect(result.tasks[2].timeoutMs).toBe(2000);
  });

  test("Panel moderator prompt includes resolved panelist outputs, not just the strategy text", async () => {
    const result = await renderWithOutputs(
      <Panel
        id="panel"
        panelists={[
          { agent, role: "security" },
          { agent: otherAgent, role: "perf" },
        ]}
        moderator={agent}
        panelistOutput="panel_out"
        moderatorOutput="moderator_out"
        strategy="synthesize"
      >
        review this
      </Panel>,
      {
        panel_out: [
          { nodeId: "panel-security", iteration: 0, verdict: "looks safe" },
          { nodeId: "panel-perf", iteration: 0, verdict: "no regressions" },
        ],
      },
    );

    const moderatorTask = result.tasks.find((task) => task.nodeId === "panel-moderator");
    expect(moderatorTask).toBeDefined();
    expect(moderatorTask.prompt).toContain("looks safe");
    expect(moderatorTask.prompt).toContain("no regressions");
    expect(moderatorTask.prompt).toContain("Synthesize the following panelist outputs");
  });

  test("Panel moderator does not deadlock when a panelist fails (continueOnFail, no output row)", async () => {
    const result = await renderWithOutputs(
      <Panel
        id="panel"
        panelists={[
          { agent, role: "security" },
          { agent: otherAgent, role: "perf" },
        ]}
        moderator={agent}
        panelistOutput="panel_out"
        moderatorOutput="moderator_out"
        strategy="synthesize"
        panelistTaskProps={{ continueOnFail: true }}
      >
        review this
      </Panel>,
      {
        // Only the "security" panelist produced output; "perf" failed and
        // wrote no row (as continueOnFail tasks do on failure).
        panel_out: [{ nodeId: "panel-security", iteration: 0, verdict: "looks safe" }],
      },
    );

    // The moderator task must still render (not defer to null) despite the
    // missing panelist output.
    const moderatorTask = result.tasks.find((task) => task.nodeId === "panel-moderator");
    expect(moderatorTask).toBeDefined();
    expect(moderatorTask.prompt).toContain("looks safe");
    // The moderator is still gated on both panelists via `needs`/dependsOn.
    expect(new Set(moderatorTask.dependsOn)).toEqual(new Set(["panel-security", "panel-perf"]));
  });

  test("Debate, ReviewLoop, Optimizer, and ScanFixVerify expand their loops", async () => {
    expect(Debate({ skipIf: true })).toBeNull();
    expect(ReviewLoop({ skipIf: true })).toBeNull();
    expect(Optimizer({ skipIf: true })).toBeNull();
    expect(ScanFixVerify({ skipIf: true })).toBeNull();

    const debate = await render(
      <Debate
        id="debate"
        proposer={agent}
        opponent={otherAgent}
        judge={agent}
        rounds={3}
        argumentOutput="argument_out"
        verdictOutput="verdict_out"
        topic="typed workflows"
      />,
    );
    expect(debate.tasks.map((task) => task.nodeId)).toEqual(["debate-proposer", "debate-opponent", "debate-judge"]);
    expect(debate.tasks[0].ralphId).toBe("debate-loop");
    expect(debate.tasks[2].needs).toEqual({
      "debate-proposer": "debate-proposer",
      "debate-opponent": "debate-opponent",
    });

    const review = await renderWithOutputs(
      <ReviewLoop
        id="review"
        producer={agent}
        reviewer={[agent, otherAgent]}
        produceOutput="produce_out"
        reviewOutput="review_out"
      >
        produce
      </ReviewLoop>,
      { produce_out: [{ nodeId: "review-produce", iteration: 0, draft: "DRAFT" }] },
    );
    expect(review.tasks[1].agent).toEqual([agent, otherAgent]);

    const optimizerWithAgent = await renderWithOutputs(
      <Optimizer id="opt" generator={agent} evaluator={otherAgent} generateOutput="gen_out" evaluateOutput="eval_out">
        generate
      </Optimizer>,
      { gen_out: [{ nodeId: "opt-generate", iteration: 0, candidate: "CANDIDATE" }] },
    );
    expect(optimizerWithAgent.tasks[1].agent).toBe(otherAgent);

    const evaluator = () => ({ score: 1 });
    const optimizerWithFn = await render(
      <Optimizer
        id="opt-fn"
        generator={agent}
        evaluator={evaluator}
        generateOutput="gen_out"
        evaluateOutput="eval_out"
        onMaxReached="fail"
      />,
    );
    expect(optimizerWithFn.tasks[1].computeFn).toBe(evaluator);

    const scan = await render(
      <ScanFixVerify
        id="sfv"
        scanner={agent}
        fixer={[agent, otherAgent]}
        verifier={agent}
        scanOutput="scan_out"
        fixOutput="fix_out"
        verifyOutput="verify_out"
        reportOutput="report_out"
        maxRetries={2}
      />,
    );
    expect(scan.tasks.map((task) => task.nodeId)).toEqual(["sfv-scan", "sfv-fix", "sfv-verify", "sfv-report"]);
    expect(scan.tasks[0].ralphId).toBe("sfv-loop");
  });

  test("DriftDetector and ContentPipeline cover branch, poll, and staged paths", async () => {
    expect(DriftDetector({ skipIf: true })).toBeNull();
    expect(ContentPipeline({ skipIf: true })).toBeNull();

    const alert = (
      <Task id="alert" output="alert_out">
        {{ alerted: true }}
      </Task>
    );
    const drift = await render(
      <DriftDetector
        id="drift"
        captureAgent={agent}
        compareAgent={otherAgent}
        captureOutput="capture_out"
        compareOutput="compare_out"
        baseline={{ hash: "abc" }}
        alert={alert}
        poll={{ maxPolls: 7 }}
      />,
    );
    expect(drift.tasks.map((task) => task.nodeId)).toEqual(["drift-capture", "drift-compare"]);
    expect(drift.tasks[0].ralphId).toBe("drift-poll");
    expect(drift.tasks[1].prompt).toContain('{"hash":"abc"}');

    const driftWithAlert = await renderWithOutputs(
      <DriftDetector
        id="drift"
        captureAgent={agent}
        compareAgent={otherAgent}
        captureOutput="capture_out"
        compareOutput="compare_out"
        baseline={{ hash: "abc" }}
        alert={alert}
      />,
      {
        compare_out: [{ nodeId: "drift-compare", iteration: 0, drifted: true }],
      },
    );
    expect(driftWithAlert.tasks.map((task) => task.nodeId)).toContain("alert");

    const driftSuppressedByAlertIf = await renderWithOutputs(
      <DriftDetector
        id="drift"
        captureAgent={agent}
        compareAgent={otherAgent}
        captureOutput="capture_out"
        compareOutput="compare_out"
        baseline={{ hash: "abc" }}
        alertIf={(comparison) => comparison?.severity === "critical"}
        alert={alert}
      />,
      {
        compare_out: [{ nodeId: "drift-compare", iteration: 0, drifted: true, severity: "minor" }],
      },
    );
    expect(driftSuppressedByAlertIf.tasks.map((task) => task.nodeId)).not.toContain("alert");

    const pipeline = await renderWithOutputs(
      <ContentPipeline
        stages={[
          { id: "outline", output: "outline_out", agent, label: "Outline" },
          { id: "draft", output: "draft_out", agent: otherAgent },
        ]}
      >
        write article
      </ContentPipeline>,
      { outline_out: [{ nodeId: "outline", iteration: 0, outline: "OUTLINE" }] },
    );
    expect(pipeline.tasks.map((task) => task.nodeId)).toEqual(["outline", "draft"]);
    expect(pipeline.tasks[1].needs).toEqual({ previous: "outline" });
  });

  test("ApprovalGate and DecisionTable cover approval, auto, first-match, and all-match paths", async () => {
    expect(ApprovalGate({ skipIf: true })).toBeNull();
    expect(DecisionTable({ skipIf: true })).toBeNull();

    const gateApproval = await render(<ApprovalGate when id="gate" output="gate_out" request={{ title: "Ship?" }} />);
    expect(gateApproval.tasks[0].needsApproval).toBe(true);

    const gateAuto = await render(
      <ApprovalGate when={false} id="gate-auto" output="gate_out" request={{ title: "Ship?" }} />,
    );
    expect(gateAuto.tasks[0].staticPayload).toMatchObject({ approved: true });

    const first = await render(
      <DecisionTable
        rules={[
          {
            when: false,
            then: (
              <Task id="no" output="out">
                {{ ok: false }}
              </Task>
            ),
          },
          {
            when: true,
            then: (
              <Task id="yes" output="out">
                {{ ok: true }}
              </Task>
            ),
          },
        ]}
        default={
          <Task id="default" output="out">
            {{ ok: "default" }}
          </Task>
        }
      />,
    );
    expect(first.tasks.map((task) => task.nodeId)).toEqual(["yes"]);

    const all = await render(
      <DecisionTable
        id="all"
        strategy="all-match"
        rules={[
          {
            when: true,
            then: (
              <Task id="a" output="out">
                {{ ok: "a" }}
              </Task>
            ),
          },
          {
            when: false,
            then: (
              <Task id="b" output="out">
                {{ ok: "b" }}
              </Task>
            ),
          },
          {
            when: true,
            then: (
              <Task id="c" output="out">
                {{ ok: "c" }}
              </Task>
            ),
          },
        ]}
      />,
    );
    expect(all.tasks.map((task) => task.nodeId)).toEqual(["a", "c"]);

    const fallback = await render(
      <DecisionTable
        strategy="all-match"
        rules={[
          {
            when: false,
            then: (
              <Task id="hidden" output="out">
                {{ ok: false }}
              </Task>
            ),
          },
        ]}
        default={
          <Task id="fallback" output="out">
            {{ ok: true }}
          </Task>
        }
      />,
    );
    expect(fallback.tasks.map((task) => task.nodeId)).toEqual(["fallback"]);
  });

  test("direct composite wrappers expose expected host element trees", async () => {
    expect(Subflow({ skipIf: true })).toBeNull();
    const subflow = Subflow({
      id: "child",
      workflow: "./child.tsx",
      input: { x: 1 },
      output: "child_out",
    });
    expect(subflow.type).toBe("smithers:subflow");
    expect(subflow.props.__smithersSubflowMode).toBe("childRun");

    const provider = { id: "remote", run: async () => ({ status: "finished", output: {} }) };
    const sandbox = Sandbox({
      id: "sandbox",
      provider,
      workflow: { build: () => null },
      output: "sandbox_out",
      allowNetwork: false,
      allowNested: true,
      env: { SECRET_TOKEN: "test-secret" },
      egress: {
        httpsProxy: "http://127.0.0.1:8080",
      },
      ports: [{ containerPort: 3000, hostPort: 13000 }],
      volumes: [{ source: "./cache", target: "/cache", readonly: true }],
      reviewDiffs: true,
      autoAcceptDiffs: false,
      memoryLimit: "512m",
      cpuLimit: "1",
      command: ["bun", "test"],
      workspace: { root: "/workspace" },
    });
    expect(sandbox.type).toBe("smithers:sandbox");
    expect(sandbox.props.runtime).toBeUndefined();
    expect(sandbox.props.__smithersSandboxProvider).toBe(provider);
    expect(sandbox.props.__smithersSandboxAllowNested).toBe(true);
    expect(sandbox.props.allowNetwork).toBe(false);
    expect(sandbox.props.env).toEqual({ SECRET_TOKEN: "test-secret" });
    expect(sandbox.props.egress).toEqual({
      httpsProxy: "http://127.0.0.1:8080",
    });
    expect(sandbox.props.ports).toEqual([{ containerPort: 3000, hostPort: 13000 }]);
    expect(sandbox.props.volumes).toEqual([{ source: "./cache", target: "/cache", readonly: true }]);
    expect(sandbox.props.reviewDiffs).toBe(true);
    expect(sandbox.props.autoAcceptDiffs).toBe(false);
    expect(sandbox.props.memoryLimit).toBe("512m");
    expect(sandbox.props.cpuLimit).toBe("1");
    expect(sandbox.props.command).toEqual(["bun", "test"]);
    expect(sandbox.props.workspace).toEqual({ root: "/workspace" });

    expect(SuperSmithers({ skipIf: true })).toBeNull();
    const dryRun = SuperSmithers({
      id: "ss",
      strategy: "Refactor",
      agent,
      targetFiles: ["src/a.ts"],
      dryRun: true,
      reportOutput: "report_out",
    });
    const dryRunChildren = childArray(dryRun);
    expect(dryRun.type).toBe("smithers:sequence");
    expect(dryRunChildren.map((child) => child.props.id)).toEqual(["ss-read", "ss-propose", "ss-report"]);
    expect(dryRunChildren.map((child) => child.props.output)).toEqual([
      "super-smithers-read",
      "super-smithers-propose",
      "report_out",
    ]);

    const applyRun = SuperSmithers({
      id: "apply",
      strategy: <p>Use JSX strategy</p>,
      agent,
      reportOutput: "report_out",
    });
    const applyChildren = childArray(applyRun);
    expect(applyChildren.map((child) => child.props.id)).toEqual([
      "apply-read",
      "apply-propose",
      "apply-apply",
      "apply-report",
    ]);
    expect(applyChildren.map((child) => child.props.output)).toEqual([
      "super-smithers-read",
      "super-smithers-propose",
      "super-smithers-apply",
      "report_out",
    ]);
    await expect(applyChildren[2].props.__smithersComputeFn()).resolves.toEqual({ applied: true });

    expect(Supervisor({ skipIf: true })).toBeNull();
    const supervisor = Supervisor({
      id: "boss",
      boss: agent,
      workers: { docs: agent, tests: otherAgent },
      planOutput: "plan_out",
      workerOutput: "worker_out",
      reviewOutput: "review_out",
      finalOutput: "final_out",
      useWorktrees: true,
      children: "plan work",
    });
    const supervisorChildren = childArray(supervisor);
    expect(supervisorChildren).toHaveLength(3);
    expect(supervisorChildren[0].props.id).toBe("boss-plan");

    const plainSupervisor = Supervisor({
      boss: agent,
      workers: { docs: agent },
      planOutput: "plan_out",
      workerOutput: "worker_out",
      reviewOutput: "review_out",
      finalOutput: "final_out",
    });
    expect(childArray(plainSupervisor)).toHaveLength(3);
  });

  test("Aspects supplies defaults, inherits parent values, and creates accumulators", () => {
    const accumulator = createAccumulator();
    expect(accumulator).toEqual({
      totalTokens: 0,
      totalLatencyMs: 0,
      taskCount: 0,
    });

    let seen;
    renderToStaticMarkup(
      <Aspects tokenBudget={{ max: 100 }} tracking={{ tokens: false }}>
        <Aspects latencySlo={{ maxMs: 250 }}>
          <AspectContext.Consumer>
            {(value) => {
              seen = value;
              return null;
            }}
          </AspectContext.Consumer>
        </Aspects>
      </Aspects>,
    );

    expect(seen.tokenBudget).toEqual({ max: 100 });
    expect(seen.latencySlo).toEqual({ maxMs: 250 });
    expect(seen.tracking).toEqual({ tokens: false, latency: true });
    expect(seen.accumulator).toEqual(accumulator);
  });

  test("Aspects: a nested scope's own tokenBudget/latencySlo override the parent's instead of inheriting them", () => {
    let seen;
    renderToStaticMarkup(
      <Aspects tokenBudget={{ max: 100 }} latencySlo={{ maxMs: 500 }}>
        <Aspects tokenBudget={{ max: 10 }} latencySlo={{ maxMs: 5 }}>
          <AspectContext.Consumer>
            {(value) => {
              seen = value;
              return null;
            }}
          </AspectContext.Consumer>
        </Aspects>
      </Aspects>,
    );

    expect(seen.tokenBudget).toEqual({ max: 10 });
    expect(seen.latencySlo).toEqual({ maxMs: 5 });
  });

  test("Aspects: nested scopes share the same accumulator instance rather than each creating a fresh one", () => {
    let outer;
    let inner;
    renderToStaticMarkup(
      <Aspects tokenBudget={{ max: 100 }}>
        <AspectContext.Consumer>
          {(value) => {
            outer = value.accumulator;
            return (
              <Aspects latencySlo={{ maxMs: 5 }}>
                <AspectContext.Consumer>
                  {(innerValue) => {
                    inner = innerValue.accumulator;
                    return null;
                  }}
                </AspectContext.Consumer>
              </Aspects>
            );
          }}
        </AspectContext.Consumer>
      </Aspects>,
    );

    expect(inner).toBe(outer);
  });

  test("Aspects: a nested scope inherits the parent's latency tracking toggle when it declares no tracking of its own", () => {
    let seen;
    renderToStaticMarkup(
      <Aspects tracking={{ latency: false }}>
        <Aspects tokenBudget={{ max: 10 }}>
          <AspectContext.Consumer>
            {(value) => {
              seen = value;
              return null;
            }}
          </AspectContext.Consumer>
        </Aspects>
      </Aspects>,
    );

    expect(seen.tracking).toEqual({ tokens: true, latency: false });
  });

  test("Aspects: with no props at all, defaults to tracking both metrics and no budgets", () => {
    let seen;
    renderToStaticMarkup(
      <Aspects>
        <AspectContext.Consumer>
          {(value) => {
            seen = value;
            return null;
          }}
        </AspectContext.Consumer>
      </Aspects>,
    );

    expect(seen.tokenBudget).toBeUndefined();
    expect(seen.latencySlo).toBeUndefined();
    expect(seen.tracking).toEqual({ tokens: true, latency: true });
  });
});

describe("zodSchemaToJsonExample", () => {
  test("generates examples for primitive, composite, optional, nullable, and enum fields", () => {
    const schema = z.object({
      title: z.string().describe("Ticket title"),
      count: z.number(),
      done: z.boolean(),
      tags: z.array(z.string()),
      status: z.enum(["open", "closed"]),
      nested: z.object({ owner: z.string() }),
      maybe: z.string().nullable(),
      optional: z.number().optional(),
    });

    expect(JSON.parse(zodSchemaToJsonExample(schema))).toEqual({
      title: "Ticket title",
      count: 0,
      done: false,
      tags: ["string"],
      status: "open",
      nested: { owner: "string" },
      maybe: "string",
      optional: 0,
    });
  });
});

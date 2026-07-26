/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import {
  CheckSuite,
  ContentPipeline,
  DriftDetector,
  Kanban,
  Runbook,
  ScanFixVerify,
  Task,
} from "../src/components/index.js";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";

const RUN_ID = "devops-components-unit";
const agent = { id: "agent", generate: async () => ({ text: "ok" }) };
const otherAgent = { id: "other", generate: async () => ({ text: "ok" }) };
const overrideAgent = { id: "override", generate: async () => ({ text: "ok" }) };
const alertAgent = { id: "alert", generate: async () => ({ text: "ok" }) };

async function render(element, outputs = {}) {
  const renderer = new SmithersRenderer();
  const ctx = new SmithersCtx({
    runId: RUN_ID,
    iteration: 0,
    input: {},
    outputs,
  });
  const graph = await renderer.render(<SmithersContext.Provider value={ctx}>{element}</SmithersContext.Provider>);
  return { graph, root: renderer.getRoot() };
}

function byId(graph, id) {
  const task = graph.tasks.find((entry) => entry.nodeId === id);
  expect(task).toBeDefined();
  return task;
}

function findHosts(root, tag) {
  const found = [];
  const visit = (node) => {
    if (!node || node.kind === "text") {
      return;
    }
    if (node.tag === tag) {
      found.push(node);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(root);
  return found;
}

function findHost(root, tag, predicate = () => true) {
  const host = findHosts(root, tag).find(predicate);
  expect(host).toBeDefined();
  return host;
}

function outputRow(nodeId, payload) {
  return {
    runId: RUN_ID,
    nodeId,
    iteration: 0,
    ...payload,
  };
}

describe("devops automation composite components", () => {
  test("CheckSuite preserves check shape and treats explicit failure markers or missing rows as failed checks", async () => {
    const passCommand = `${JSON.stringify(process.execPath)} -e "console.log('check ok')"`;
    const { graph } = await render(
      <CheckSuite
        id="gate"
        strategy="any-pass"
        verdictOutput="verdict_out"
        maxConcurrency={2}
        continueOnFail={false}
        checks={[
          { id: "cmd", command: passCommand, label: "Command check" },
          { id: "agent", agent, label: "Agent check" },
          { id: "bad", agent: otherAgent },
          { id: "missing", agent: otherAgent },
        ]}
      />,
      {
        verdict_out: [
          outputRow("gate-cmd", { ok: true }),
          outputRow("gate-agent", { error: "boom" }),
          outputRow("gate-bad", { ok: false }),
        ],
      },
    );

    const commandCheck = byId(graph, "gate-cmd");
    expect(commandCheck.staticPayload).toBeUndefined();
    expect(typeof commandCheck.computeFn).toBe("function");
    await expect(commandCheck.computeFn()).resolves.toMatchObject({
      passed: true,
      ok: true,
      command: passCommand,
      exitCode: 0,
    });
    expect(commandCheck.agent).toBeUndefined();
    expect(commandCheck.continueOnFail).toBe(false);
    expect(commandCheck.parallelMaxConcurrency).toBe(2);

    const agentCheck = byId(graph, "gate-agent");
    expect(agentCheck.agent).toBe(agent);
    expect(agentCheck.prompt).toBe("Run check: Agent check");
    expect(agentCheck.parallelMaxConcurrency).toBe(2);

    const verdict = await byId(graph, "gate-verdict").computeFn();
    expect(verdict).toEqual({
      passed: true,
      passCount: 1,
      total: 4,
      strategy: "any-pass",
      results: {
        cmd: true,
        agent: false,
        bad: false,
        missing: false,
      },
    });
  });

  test("CheckSuite empty input renders only a failing aggregate verdict", async () => {
    const { graph } = await render(
      <CheckSuite id="empty" verdictOutput="verdict_out" checks={[]} strategy="all-pass" />,
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual(["empty-verdict"]);
    const verdictTask = byId(graph, "empty-verdict");
    expect(verdictTask.dependsOn ?? []).toEqual([]);
    expect(verdictTask.computeFn()).toEqual({
      passed: false,
      passCount: 0,
      total: 0,
      strategy: "all-pass",
      results: {},
    });
  });

  test("CheckSuite majority strategy requires strictly more than half of checks to pass", async () => {
    const tied = await render(
      <CheckSuite
        id="tie"
        verdictOutput="verdict_out"
        strategy="majority"
        checks={[
          { id: "pass", agent },
          { id: "fail", agent: otherAgent },
        ]}
      />,
      {
        verdict_out: [outputRow("tie-pass", { ok: true }), outputRow("tie-fail", { failed: true })],
      },
    );
    expect(await byId(tied.graph, "tie-verdict").computeFn()).toEqual({
      passed: false,
      passCount: 1,
      total: 2,
      strategy: "majority",
      results: {
        pass: true,
        fail: false,
      },
    });

    const majority = await render(
      <CheckSuite
        id="majority"
        verdictOutput="verdict_out"
        strategy="majority"
        checks={[
          { id: "one", agent },
          { id: "two", agent },
          { id: "three", agent: otherAgent },
        ]}
      />,
      {
        verdict_out: [
          outputRow("majority-one", { ok: true }),
          outputRow("majority-two", { passed: true }),
          outputRow("majority-three", { ok: false }),
        ],
      },
    );
    expect(await byId(majority.graph, "majority-verdict").computeFn()).toEqual({
      passed: true,
      passCount: 2,
      total: 3,
      strategy: "majority",
      results: {
        one: true,
        two: true,
        three: false,
      },
    });
  });

  test("Kanban expands dynamic tickets through ordered columns with loop caps, overrides, and completion output", async () => {
    let ticketReads = 0;
    const tickets = [
      { id: "T1", title: "Fix deploy button" },
      { id: "T2", title: "Add rollback link" },
    ];
    const completion = { done: ["T1", "T2"] };

    const { graph, root } = await render(
      <Kanban
        id="board"
        columns={[
          {
            name: "todo",
            agent,
            output: "todo_out",
            prompt: ({ item, column }) => `${column}:${item.id}:${item.title}`,
            task: { timeoutMs: 500, continueOnFail: false },
          },
          { name: "review", agent, output: "review_out" },
        ]}
        useTickets={() => {
          ticketReads += 1;
          return tickets;
        }}
        agents={{ review: overrideAgent }}
        maxConcurrency={3}
        until
        maxIterations={9}
        onComplete="board_out"
      >
        {completion}
      </Kanban>,
    );

    expect(ticketReads).toBe(1);
    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual([
      "board-todo-T1",
      "board-todo-T2",
      "board-review-T1",
      "board-review-T2",
      "board-complete",
    ]);
    expect(byId(graph, "board-todo-T1")).toMatchObject({
      agent,
      outputTableName: "todo_out",
      prompt: "todo:T1:Fix deploy button",
      timeoutMs: 500,
      continueOnFail: false,
      parallelMaxConcurrency: 3,
      label: "todo: T1",
    });
    expect(byId(graph, "board-review-T1")).toMatchObject({
      agent: overrideAgent,
      outputTableName: "review_out",
      prompt: 'Process item T1 in column "review".',
      parallelMaxConcurrency: 3,
      label: "review: T1",
    });
    expect(byId(graph, "board-complete")).toMatchObject({
      outputTableName: "board_out",
      staticPayload: completion,
      label: "Board complete",
    });

    const loop = findHost(root, "smithers:ralph", (node) => node.rawProps.id === "board-loop");
    expect(loop.rawProps.until).toBe(true);
    expect(loop.rawProps.maxIterations).toBe(9);
    expect(loop.rawProps.onMaxReached).toBe("return-last");
  });

  test("Runbook wires safe steps, approval gates, defaults, overrides, and deny policy in sequence", async () => {
    const stepAgent = { id: "step", generate: async () => ({ text: "ok" }) };
    const { graph } = await render(
      <Runbook
        id="ops"
        defaultAgent={agent}
        stepOutput="step_out"
        approvalRequest={{
          title: "Approve runbook step",
          summary: "Use the change-control template.",
          metadata: { change: "CHG-123", elevated: false },
        }}
        steps={[
          {
            id: "prepare",
            risk: "safe",
            label: "Prepare environment",
            agent: stepAgent,
            output: "prepare_out",
          },
          { id: "migrate", risk: "risky", command: "pnpm db:migrate" },
          { id: "cutover", risk: "critical", command: "switch traffic" },
        ]}
      />,
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual([
      "ops-prepare",
      "ops-migrate-approval",
      "ops-migrate",
      "ops-cutover-approval",
      "ops-cutover",
    ]);
    expect(byId(graph, "ops-prepare")).toMatchObject({
      agent: stepAgent,
      outputTableName: "prepare_out",
      prompt: "Execute step: Prepare environment",
      label: "[safe] Prepare environment",
    });
    expect(byId(graph, "ops-migrate-approval")).toMatchObject({
      needsApproval: true,
      approvalOnDeny: "fail",
      needs: { previousStep: "ops-prepare" },
      label: "Approve: migrate",
    });
    expect(byId(graph, "ops-migrate-approval").meta).toMatchObject({
      requestSummary: "Use the change-control template.",
      stepId: "migrate",
      risk: "risky",
      change: "CHG-123",
      elevated: false,
    });
    expect(byId(graph, "ops-migrate")).toMatchObject({
      agent,
      outputTableName: "step_out",
      needs: { approval: "ops-migrate-approval" },
      prompt: "pnpm db:migrate",
    });
    expect(byId(graph, "ops-cutover-approval")).toMatchObject({
      needs: { previousStep: "ops-migrate" },
      approvalOnDeny: "fail",
    });
    expect(byId(graph, "ops-cutover-approval").meta).toMatchObject({
      stepId: "cutover",
      risk: "critical",
      change: "CHG-123",
      elevated: true,
    });
  });

  test("Runbook onDeny=skip omits denied risky steps and chains later steps after the approval gate", async () => {
    const { graph } = await render(
      <Runbook
        id="skipbook"
        defaultAgent={agent}
        stepOutput="step_out"
        onDeny="skip"
        steps={[
          { id: "migrate", risk: "risky", command: "pnpm db:migrate" },
          { id: "cleanup", risk: "safe", command: "pnpm cleanup" },
        ]}
      />,
      {
        "skipbook-migrate-approval-decision": [outputRow("skipbook-migrate-approval", { approved: false })],
      },
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual(["skipbook-migrate-approval", "skipbook-cleanup"]);
    expect(byId(graph, "skipbook-migrate-approval")).toMatchObject({
      needsApproval: true,
      approvalOnDeny: "skip",
    });
    expect(byId(graph, "skipbook-cleanup")).toMatchObject({
      needs: { previousStep: "skipbook-migrate-approval" },
      prompt: "pnpm cleanup",
    });
  });

  test("ScanFixVerify keeps the full fixer chain and applies retry and parallel limits structurally", async () => {
    const fixers = [agent, otherAgent];
    const { graph, root } = await render(
      <ScanFixVerify
        id="qa"
        scanner={overrideAgent}
        fixer={fixers}
        verifier={alertAgent}
        scanOutput="scan_out"
        fixOutput="fix_out"
        verifyOutput="verify_out"
        reportOutput="report_out"
        maxConcurrency={4}
        maxRetries={6}
      >
        scan the deployment scripts
      </ScanFixVerify>,
    );

    expect(byId(graph, "qa-scan")).toMatchObject({
      agent: overrideAgent,
      prompt: "scan the deployment scripts",
      ralphId: "qa-loop",
    });
    expect(byId(graph, "qa-fix")).toMatchObject({
      agent: fixers,
      dependsOn: ["qa-scan"],
      parallelMaxConcurrency: 4,
      ralphId: "qa-loop",
    });
    expect(byId(graph, "qa-verify")).toMatchObject({
      agent: alertAgent,
      dependsOn: ["qa-fix"],
      ralphId: "qa-loop",
    });
    expect(byId(graph, "qa-report")).toMatchObject({
      agent: alertAgent,
      dependsOn: ["qa-verify"],
    });

    const loop = findHost(root, "smithers:ralph", (node) => node.rawProps.id === "qa-loop");
    expect(loop.rawProps.maxIterations).toBe(6);
    expect(loop.rawProps.onMaxReached).toBe("return-last");
  });

  test("DriftDetector captures baselines, polls with bounded iterations, and fires custom alert actions", async () => {
    const alert = (
      <Task id="notify" output="alert_out" agent={alertAgent}>
        alert operations
      </Task>
    );
    const { graph, root } = await render(
      <DriftDetector
        id="config"
        captureAgent={agent}
        compareAgent={otherAgent}
        captureOutput="capture_out"
        compareOutput="compare_out"
        baseline={{ version: 7 }}
        alertIf={(comparison) => comparison?.severity === "critical"}
        alert={alert}
        poll={{ intervalMs: 25, maxPolls: 2 }}
      />,
      {
        compare_out: [outputRow("config-compare", { drifted: false, severity: "critical" })],
      },
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual(["config-capture", "config-compare", "notify"]);
    expect(byId(graph, "config-capture")).toMatchObject({
      agent,
      outputTableName: "capture_out",
      ralphId: "config-poll",
    });
    expect(byId(graph, "config-capture").prompt).toContain('{"version":7}');
    expect(byId(graph, "config-compare")).toMatchObject({
      agent: otherAgent,
      dependsOn: ["config-capture"],
      outputTableName: "compare_out",
      ralphId: "config-poll",
    });
    expect(byId(graph, "notify")).toMatchObject({
      agent: alertAgent,
      outputTableName: "alert_out",
      prompt: "alert operations",
      ralphId: "config-poll",
    });

    const loop = findHost(root, "smithers:ralph", (node) => node.rawProps.id === "config-poll");
    expect(loop.rawProps.until).toBe(false);
    expect(loop.rawProps.maxIterations).toBe(2);
    expect(loop.rawProps.onMaxReached).toBe("return-last");
  });

  test("DriftDetector rejects non-finite polling caps before creating an unbounded loop", async () => {
    await expect(
      render(
        <DriftDetector
          id="config"
          captureAgent={agent}
          compareAgent={otherAgent}
          captureOutput="capture_out"
          compareOutput="compare_out"
          baseline="v1"
          poll={{ maxPolls: Number.POSITIVE_INFINITY }}
        />,
      ),
    ).rejects.toThrow("DriftDetector poll.maxPolls must be a finite number.");
  });

  test("ScanFixVerify rejects an empty fixer array instead of scheduling agentless fix tasks", async () => {
    await expect(
      render(
        <ScanFixVerify
          id="qa"
          scanner={agent}
          fixer={[]}
          verifier={alertAgent}
          scanOutput="scan_out"
          fixOutput="fix_out"
          verifyOutput="verify_out"
          reportOutput="report_out"
        />,
      ),
    ).rejects.toThrow("ScanFixVerify fixer array must contain at least one agent.");
  });

  test("ScanFixVerify expands one fix task per scan issue with rotated fixer chains", async () => {
    const { graph } = await render(
      <ScanFixVerify
        id="qa"
        scanner={agent}
        fixer={[agent, otherAgent]}
        verifier={alertAgent}
        scanOutput="scan_out"
        fixOutput="fix_out"
        verifyOutput="verify_out"
        reportOutput="report_out"
      />,
      {
        scan_out: [outputRow("qa-scan", { issues: ["lint failure", { file: "a.ts" }] })],
      },
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual([
      "qa-scan",
      "qa-fix-0",
      "qa-fix-1",
      "qa-verify",
      "qa-report",
    ]);
    const fixZero = byId(graph, "qa-fix-0");
    expect(fixZero.agent).toEqual([agent, otherAgent]);
    expect(fixZero.prompt).toBe("Fix scan issue 1 of 2: lint failure");
    const fixOne = byId(graph, "qa-fix-1");
    expect(fixOne.agent).toEqual([otherAgent, agent]);
    expect(fixOne.prompt).toBe('Fix scan issue 2 of 2: {"file":"a.ts"}');
    expect(byId(graph, "qa-verify").dependsOn).toEqual(["qa-fix-0", "qa-fix-1"]);

    const singleFixer = await render(
      <ScanFixVerify
        id="solo"
        scanner={agent}
        fixer={[overrideAgent]}
        verifier={alertAgent}
        scanOutput="scan_out"
        fixOutput="fix_out"
        verifyOutput="verify_out"
        reportOutput="report_out"
      />,
      {
        scan_out: [outputRow("solo-scan", { issues: ["only issue"] })],
      },
    );
    expect(byId(singleFixer.graph, "solo-fix-0").agent).toBe(overrideAgent);
  });

  test("ScanFixVerify with a clean scan skips fix tasks, verifies straight after the scan, and applies defaults", async () => {
    const { graph, root } = await render(
      <ScanFixVerify
        scanner={agent}
        fixer={otherAgent}
        verifier={alertAgent}
        scanOutput="scan_out"
        fixOutput="fix_out"
        verifyOutput="verify_out"
        reportOutput="report_out"
      />,
      {
        scan_out: [outputRow("sfv-scan", { issues: [] })],
      },
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual(["sfv-scan", "sfv-verify", "sfv-report"]);
    expect(byId(graph, "sfv-scan").prompt).toBe("Scan for problems and return an issues array.");
    expect(byId(graph, "sfv-verify").dependsOn).toEqual(["sfv-scan"]);

    const loop = findHost(root, "smithers:ralph", (node) => node.rawProps.id === "sfv-loop");
    expect(loop.rawProps.maxIterations).toBe(3);
    expect(loop.rawProps.onMaxReached).toBe("return-last");
  });

  test("Kanban defaults omit the completion task and bound the loop at five iterations", async () => {
    expect(Kanban({ skipIf: true })).toBeNull();

    const { graph, root } = await render(
      <Kanban columns={[{ name: "todo", agent, output: "todo_out" }]} useTickets={() => [{ id: "A" }]} />,
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual(["kanban-todo-A"]);
    expect(byId(graph, "kanban-todo-A")).toMatchObject({
      agent,
      continueOnFail: true,
      label: "todo: A",
      prompt: 'Process item A in column "todo".',
    });

    const loop = findHost(root, "smithers:ralph", (node) => node.rawProps.id === "kanban-loop");
    expect(loop.rawProps.until).toBe(false);
    expect(loop.rawProps.maxIterations).toBe(5);
    expect(loop.rawProps.onMaxReached).toBe("return-last");
  });

  test("Kanban with zero tickets emits no column tasks but still writes the completion output", async () => {
    const noTickets = await render(
      <Kanban
        id="idle"
        columns={[
          { name: "todo", agent, output: "todo_out" },
          { name: "review", agent: otherAgent, output: "review_out" },
        ]}
        useTickets={() => []}
      />,
    );
    expect(noTickets.graph.tasks).toEqual([]);

    const withComplete = await render(
      <Kanban
        id="idle"
        columns={[{ name: "todo", agent, output: "todo_out" }]}
        useTickets={() => []}
        onComplete="board_out"
      >
        {{ done: [] }}
      </Kanban>,
    );
    expect(withComplete.graph.tasks.map((entry) => entry.nodeId)).toEqual(["idle-complete"]);
    expect(byId(withComplete.graph, "idle-complete")).toMatchObject({
      outputTableName: "board_out",
      staticPayload: { done: [] },
    });
  });

  test("Runbook onDeny=skip keeps an approved risky step gated on the approval decision", async () => {
    const { graph } = await render(
      <Runbook
        id="okbook"
        defaultAgent={agent}
        stepOutput="step_out"
        onDeny="skip"
        steps={[
          { id: "migrate", risk: "risky", command: "pnpm db:migrate" },
          { id: "cleanup", risk: "safe", command: "pnpm cleanup" },
        ]}
      />,
      {
        "okbook-migrate-approval-decision": [outputRow("okbook-migrate-approval", { approved: true })],
      },
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual([
      "okbook-migrate-approval",
      "okbook-migrate",
      "okbook-cleanup",
    ]);
    expect(byId(graph, "okbook-migrate")).toMatchObject({
      needs: { approval: "okbook-migrate-approval" },
      dependsOn: ["okbook-migrate-approval"],
      prompt: "pnpm db:migrate",
    });
    expect(byId(graph, "okbook-cleanup")).toMatchObject({
      needs: { previousStep: "okbook-migrate" },
    });
  });

  test("Runbook derives default approval titles and summaries from risk and command", async () => {
    const emptySteps = await render(<Runbook defaultAgent={agent} stepOutput="step_out" steps={[]} />);
    expect(emptySteps.graph.tasks).toEqual([]);

    const { graph } = await render(
      <Runbook
        defaultAgent={agent}
        stepOutput="step_out"
        steps={[
          { id: "migrate", risk: "risky", command: "pnpm db:migrate" },
          { id: "cutover", risk: "critical" },
        ]}
      />,
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual([
      "runbook-migrate-approval",
      "runbook-migrate",
      "runbook-cutover-approval",
      "runbook-cutover",
    ]);
    const riskyApproval = byId(graph, "runbook-migrate-approval");
    expect(riskyApproval.meta).toMatchObject({
      requestTitle: "Approve risky step: migrate",
      requestSummary: "Risky step requires approval before execution. Command: pnpm db:migrate",
      stepId: "migrate",
      risk: "risky",
    });
    expect(riskyApproval.meta.elevated).toBeUndefined();
    expect(riskyApproval.approvalOnDeny).toBe("fail");

    const criticalApproval = byId(graph, "runbook-cutover-approval");
    expect(criticalApproval.meta).toMatchObject({
      requestTitle: "Approve CRITICAL step: cutover",
      requestSummary: "CRITICAL step requires elevated approval. Command: cutover",
      elevated: true,
    });
  });

  test("CheckSuite defaults to the checksuite prefix and all-pass strategy, and error:false does not fail a check", async () => {
    const { graph } = await render(
      <CheckSuite
        verdictOutput="verdict_out"
        checks={[
          { id: "a", agent },
          { id: "b", agent: otherAgent },
        ]}
      />,
      {
        verdict_out: [outputRow("checksuite-a", { ok: true, error: false }), outputRow("checksuite-b", {})],
      },
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual(["checksuite-a", "checksuite-b", "checksuite-verdict"]);
    expect(byId(graph, "checksuite-a").continueOnFail).toBe(true);
    expect(await byId(graph, "checksuite-verdict").computeFn()).toEqual({
      passed: true,
      passCount: 2,
      total: 2,
      strategy: "all-pass",
      results: { a: true, b: true },
    });
  });

  test("DriftDetector defaults the poll cap to 100 iterations and renders no alert branch without an alert element", async () => {
    const { graph, root } = await render(
      <DriftDetector
        captureAgent={agent}
        compareAgent={otherAgent}
        captureOutput="capture_out"
        compareOutput="compare_out"
        baseline="prod-v1"
        poll={{}}
      />,
      {
        compare_out: [outputRow("drift-compare", { drifted: true })],
      },
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual(["drift-capture", "drift-compare"]);
    expect(byId(graph, "drift-capture").prompt).toContain("Baseline reference: prod-v1");
    expect(byId(graph, "drift-compare").prompt).toContain("Baseline: prod-v1");

    const loop = findHost(root, "smithers:ralph", (node) => node.rawProps.id === "drift-poll");
    expect(loop.rawProps.until).toBe(false);
    expect(loop.rawProps.maxIterations).toBe(100);
    expect(loop.rawProps.onMaxReached).toBe("return-last");
  });

  test("ContentPipeline single stage receives the seed prompt with no invented dependencies", async () => {
    const { graph } = await render(
      <ContentPipeline stages={[{ id: "only", output: "only_out", agent }]}>seed prompt</ContentPipeline>,
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual(["only"]);
    expect(byId(graph, "only")).toMatchObject({
      agent,
      outputTableName: "only_out",
      needs: undefined,
      prompt: "seed prompt",
    });
  });

  test("ContentPipeline handles empty and multi-stage pipelines without inventing dependencies", async () => {
    const empty = await render(<ContentPipeline stages={[]}>seed</ContentPipeline>);
    expect(empty.graph.tasks).toEqual([]);

    const { graph } = await render(
      <ContentPipeline
        stages={[
          { id: "outline", output: "outline_out", agent, label: "Outline" },
          { id: "draft", output: "draft_out", agent: otherAgent, label: "Draft copy" },
          { id: "publish", output: "publish_out", agent: overrideAgent },
        ]}
      >
        write the release announcement
      </ContentPipeline>,
      {
        outline_out: [{ nodeId: "outline", iteration: 0, outline: "OUTLINE TEXT" }],
        draft_out: [{ nodeId: "draft", iteration: 0, draft: "DRAFT TEXT" }],
      },
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual(["outline", "draft", "publish"]);
    expect(byId(graph, "outline")).toMatchObject({
      agent,
      outputTableName: "outline_out",
      needs: undefined,
      prompt: "write the release announcement",
    });
    expect(byId(graph, "draft")).toMatchObject({
      agent: otherAgent,
      outputTableName: "draft_out",
      needs: { previous: "outline" },
    });
    expect(byId(graph, "draft").prompt).toContain("Continue from the previous stage's output. Perform: Draft copy");
    expect(byId(graph, "draft").prompt).toContain("OUTLINE TEXT");
    expect(byId(graph, "publish")).toMatchObject({
      agent: overrideAgent,
      outputTableName: "publish_out",
      needs: { previous: "draft" },
    });
    expect(byId(graph, "publish").prompt).toContain("Continue from the previous stage's output. Perform: publish");
    expect(byId(graph, "publish").prompt).toContain("DRAFT TEXT");
  });
});

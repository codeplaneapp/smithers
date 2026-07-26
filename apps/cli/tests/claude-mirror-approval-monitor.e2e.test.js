import { describe, expect, test } from "bun:test";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";
import { findAndOpenDb } from "../src/find-db.js";
import { readClaudeMirrorSubscriptions } from "../src/claude-mirror/readClaudeMirrorSubscriptions.js";
import { resolveClaudeMirrorSubscriptionsPath } from "../src/claude-mirror/resolveClaudeMirrorSubscriptionsPath.js";
import { runClaudeMonitor } from "../src/claude-mirror/runClaudeMonitor.js";

// Approval gates through the mirror protocol, against a real suspended run:
// `claude tick` surfaces the pending approval, `claude node-wait` times out
// (not fails) on the gated node, and `claude monitor` emits the
// approval-pending NDJSON line the plugin's background monitor delivers.
// Every CLI call pins CLAUDE_CODE_SESSION_ID so the subscription side
// (launch-path subscribe, tick subscribe, session-scoped monitor, terminal
// prune) is exercised deterministically both locally and in CI.

const SESSION_ID = "mirror-e2e-session";
const SESSION_ENV = { CLAUDE_CODE_SESSION_ID: SESSION_ID };

const APPROVAL_WORKFLOW = `
/** @jsxImportSource smithers-orchestrator */
import { Approval, createSmithers, Task, Workflow } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, outputs } = createSmithers({
  approval: z.object({ approved: z.boolean(), note: z.string().nullable() }),
  gated: z.object({ marker: z.string() }),
});

export default smithers((ctx) => {
  const approval = ctx.outputMaybe(outputs.approval, { nodeId: "gate" });
  return (
    <Workflow name="mirror-approval-e2e">
      <Approval
        id="gate"
        output={outputs.approval}
        request={{
          title: "Approve mirror test",
          summary: "Lets the gated task run.",
        }}
        onDeny="fail"
      />
      {approval?.approved ? (
        <Task id="gated" output={outputs.gated}>
          {async () => ({ marker: "gated-ran" })}
        </Task>
      ) : null}
    </Workflow>
  );
});
`;

const WAITING = new Set(["waiting-approval"]);
const TERMINAL = new Set(["finished", "failed", "cancelled", "continued"]);

/** @param {{ dir: string }} repo @param {string[]} args */
function tryClaudeJson(repo, args) {
  const result = runSmithers(["claude", ...args], { cwd: repo.dir, format: "json", env: SESSION_ENV });
  return result.exitCode === 0 ? result.json : undefined;
}

describe("claude mirror approvals + monitor (real run)", () => {
  test("tick surfaces the gate, node-wait times out politely, monitor emits approval-pending", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write("workflow.tsx", APPROVAL_WORKFLOW);

    const runId = "mirror-approval-run";
    const up = runSmithers(["up", "workflow.tsx", "--detach", "--run-id", runId], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 120_000,
      env: SESSION_ENV,
    });
    expect(up.exitCode, `${up.stdout}\n${up.stderr}`).toBe(0);

    // Detaching from inside a Claude Code session subscribed that session.
    const subscriptionsPath = resolveClaudeMirrorSubscriptionsPath(repo.dir);
    expect(readClaudeMirrorSubscriptions(subscriptionsPath, Date.now())).toMatchObject([
      { runId, sessionId: SESSION_ID },
    ]);

    let tick;
    for (let index = 0; index < 200; index += 1) {
      tick = tryClaudeJson(repo, ["tick", runId]);
      if (tick && WAITING.has(tick.status) && tick.approvals.length > 0) {
        break;
      }
      Bun.sleepSync(150);
    }
    expect(tick, "run never suspended on the approval gate").toBeTruthy();
    expect(tick.status).toBe("waiting-approval");
    expect(tick.approvals).toEqual([
      {
        nodeId: "gate",
        iteration: 0,
        title: "Approve mirror test",
        requestedAtMs: expect.any(Number),
      },
    ]);
    const gateNode = tick.nodes.find((node) => node.nodeId === "gate");
    expect(gateNode).toBeTruthy();

    // A watcher on the gated node waits (timedOut: true), it does not fail.
    const waited = tryClaudeJson(repo, ["node-wait", "gate", "--run-id", runId, "--timeout-ms", "1200"]);
    expect(waited.timedOut).toBe(true);
    expect(waited.vanished).toBe(false);
    expect(TERMINAL.has(waited.state)).toBe(false);

    // The plugin monitor surfaces the pending gate on first sight — for
    // the session that subscribed. A different session's monitor over the
    // same shared store stays silent.
    const { adapter, cleanup } = await findAndOpenDb(repo.dir);
    try {
      const lines = [];
      await runClaudeMonitor(adapter, {
        ticks: 1,
        intervalMs: 250,
        subscriptionsPath,
        sessionId: SESSION_ID,
        write: (line) => lines.push(JSON.parse(line)),
      });
      const approvalLine = lines.find((line) => line.kind === "approval-pending" && line.runId === runId);
      expect(approvalLine, JSON.stringify(lines)).toBeTruthy();
      expect(approvalLine.nodeId).toBe("gate");
      expect(approvalLine.title).toBe("Approve mirror test");
      expect(approvalLine.action).toContain(`smithers approve ${runId}`);

      const otherSessionLines = [];
      await runClaudeMonitor(adapter, {
        ticks: 1,
        intervalMs: 250,
        subscriptionsPath,
        sessionId: "some-other-session",
        write: (line) => otherSessionLines.push(line),
      });
      expect(otherSessionLines).toEqual([]);
    } finally {
      cleanup();
    }

    // Approve, resume to completion, and confirm the mirror sees it all.
    const approve = runSmithers(["approve", runId, "--node", "gate"], { cwd: repo.dir, format: "json" });
    expect(approve.exitCode, `${approve.stdout}\n${approve.stderr}`).toBe(0);
    const resume = runSmithers(["up", "workflow.tsx", "--resume", runId], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(resume.exitCode, `${resume.stdout}\n${resume.stderr}`).toBe(0);

    let finalTick;
    for (let index = 0; index < 100; index += 1) {
      finalTick = tryClaudeJson(repo, ["tick", runId]);
      if (finalTick && TERMINAL.has(finalTick.status)) {
        break;
      }
      Bun.sleepSync(150);
    }
    expect(finalTick.status).toBe("finished");
    expect(finalTick.approvals).toEqual([]);
    const gated = tryClaudeJson(repo, ["node-wait", "gated", "--run-id", runId]);
    expect(gated.state).toBe("finished");
    expect(gated.output).toContain("gated-ran");

    // A monitor that first sees the run when it is terminal stays silent
    // (no history replay, no stale notifications) and prunes the finished
    // run's subscription so no future monitor re-inspects it.
    const { adapter: adapter2, cleanup: cleanup2 } = await findAndOpenDb(repo.dir);
    try {
      const lines = [];
      await runClaudeMonitor(adapter2, {
        ticks: 1,
        intervalMs: 250,
        subscriptionsPath,
        sessionId: SESSION_ID,
        write: (line) => lines.push(line),
      });
      expect(lines).toEqual([]);
      expect(readClaudeMirrorSubscriptions(subscriptionsPath, Date.now())).toEqual([]);
    } finally {
      cleanup2();
    }
    // Real detached run + suspend + resume: needs far more than the 5s default.
  }, 90_000);
});

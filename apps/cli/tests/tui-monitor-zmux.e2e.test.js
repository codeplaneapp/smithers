// Real-PTY e2e for the full-screen run MONITOR itself (packages/tui), driven
// through zmux (github.com/smithersai/zmux). The interactive picker flow is
// covered by tui-zmux.e2e.test.js; this file exercises the monitor's own
// contract from packages/tui/README.md: mode switching (g/l/t/h, 1-5, the g
// tree/graph toggle), the Tree inspector tabs (1-4), the ? help overlay,
// terminal resize, quitting with q, and approving a gated run from inside the
// TUI all the way to run completion.
//
// Every test runs the seeded `e2e-approval-probe` workflow: it parks at an
// Approval gate, so the monitor stays alive indefinitely while we walk modes —
// and pressing [a] releases the gated task so the run completes for real.
//
// The `zmuxd` daemon binary is NOT present on the clean CI box by default. When
// `resolveZmuxd()` returns null these tests skip cleanly so CI stays green;
// CI installs the daemon, exports ZMUXD, and runs them explicitly.
import { describe, expect, test } from "bun:test";
import {
  REPO_ROOT,
  KEY,
  sleep,
  resolveZmuxd,
  startDaemon,
  emulate,
  freePort,
  gatewayRpc,
  stopGatewayPort,
  runIdFromGrid,
  cancelLatestRun,
  isolatedGatewayEnv,
  navigateToWorkflow,
  paneDriver,
} from "./zmux-harness.js";

const ZMUXD = resolveZmuxd();
// Agent harnesses often run inside a nested PTY with a real zmuxd on PATH; that
// environment is not stable enough for these real-terminal assertions.
const AGENT_HARNESS = Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CODEX_CI);

// Each test gets an isolated singleton-gateway state dir (see isolatedGatewayEnv).
const interactiveCommand = (iso) => `${iso.pane}bun apps/cli/src/index.js up --interactive`;

/** Poll `grid()` until a line matches `re` (or tries run out). Returns the last grid. */
async function until(grid, re, { tries = 60, delayMs = 400 } = {}) {
  let g = [];
  for (let i = 0; i < tries; i += 1) {
    g = await grid();
    if (g.some((line) => re.test(line))) return { ok: true, grid: g };
    await sleep(delayMs);
  }
  return { ok: false, grid: g };
}

/**
 * Boot the interactive flow inside a zmux pane, pick the approval probe, and
 * wait until the monitor renders the parked run (Tree mode, paused header).
 * Returns the pane driver plus the visible runId.
 */
async function startParkedMonitor(rpc, sessionId, { cols, rows }) {
  const pane = paneDriver(rpc, sessionId, { cols, rows });
  const reached = await navigateToWorkflow(pane.send, pane.grid, "approval probe", /e2e approval probe/i);
  expect(reached).toBe(true);
  await pane.send(KEY.enter);

  // The monitor is up once the paused gate node renders in the tree.
  const gate = await until(pane.grid, /Approve E2E gated task/i, { tries: 120, delayMs: 500 });
  if (!gate.ok) throw new Error(`monitor never rendered the parked gate\n${gate.grid.join("\n")}`);
  return { pane, runId: runIdFromGrid(gate.grid) };
}

describe.skipIf(ZMUXD == null || AGENT_HARNESS)("smithers monitor zmux PTY", () => {
  test("walks every mode, the g toggle, the help overlay, and resize", async () => {
    const cols = 100;
    const rows = 30;
    const testStartedAtMs = Date.now();
    const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-mon-modes", idleSeconds: 240 });
    const gatewayPort = await freePort();
    const iso = isolatedGatewayEnv(gatewayPort);
    let sessionId;
    let runId = null;
    try {
      const created = await rpc("session.create", {
        command: interactiveCommand(iso),
        cwd: REPO_ROOT,
        cols,
        rows,
      });
      sessionId = created.id;
      const started = await startParkedMonitor(rpc, sessionId, { cols, rows });
      const { pane } = started;
      runId = started.runId;
      expect(runId).not.toBeNull();

      // Tree mode: inspector tab bar + tree-specific keybar.
      const tree = await until(pane.grid, /output\s+logs\s+diff\s+props/);
      expect(tree.ok).toBe(true);
      expect(tree.grid.some((line) => /\[1-4\] Tabs/.test(line))).toBe(true);

      // g → Graph (with its own keybar hints and the run's node boxes).
      await pane.send("g");
      const graph = await until(pane.grid, /GRAPH — \d+ node/);
      expect(graph.ok).toBe(true);
      expect(graph.grid.some((line) => /\[g\] toggle tree\/graph/.test(line))).toBe(true);
      expect(graph.grid.some((line) => /e2e-approval-p/.test(line))).toBe(true);

      // g again toggles BACK to Tree (README: g toggles between Graph and Tree).
      await pane.send("g");
      const backFromGraph = await until(pane.grid, /output\s+logs\s+diff\s+props/);
      expect(backFromGraph.ok).toBe(true);

      // l → Logs. The run parked BEFORE the monitor attached, so any
      // events here prove the gateway replays its buffered history to a
      // late subscriber (the out-of-process bridge backfill + the
      // client's afterSeq:0 replay request) — a monitor of a parked run
      // used to show "0/0 events" forever.
      await pane.send("l");
      const logs = await until(pane.grid, /LOGS \[live\]\s+[1-9]\d*\/\d+ events/, { tries: 30 });
      expect(logs.ok).toBe(true);
      expect(logs.grid.some((line) => /\[f\] follow/.test(line))).toBe(true);

      // t → Timeline.
      await pane.send("t");
      const timeline = await until(pane.grid, /TIMELINE \[live\]/);
      expect(timeline.ok).toBe(true);

      // Numeric switches work from any non-Tree mode: 2 → Graph, 3 → Logs.
      await pane.send("2");
      expect((await until(pane.grid, /GRAPH — \d+ node/)).ok).toBe(true);
      await pane.send("3");
      expect((await until(pane.grid, /LOGS \[live\]/)).ok).toBe(true);

      // h → Hijack. The run is parked (no RUNNING node), so the picker
      // reports there is nothing to hand off to.
      await pane.send("h");
      const hijack = await until(pane.grid, /HIJACK/);
      expect(hijack.ok).toBe(true);
      expect(hijack.grid.some((line) => /no running nodes/i.test(line))).toBe(true);

      // 1 → back to Tree from Hijack.
      await pane.send("1");
      const treeAgain = await until(pane.grid, /output\s+logs\s+diff\s+props/);
      expect(treeAgain.ok).toBe(true);

      // ? opens the help overlay (mode-aware); Esc closes it.
      await pane.send("?");
      const help = await until(pane.grid, /Keybindings/);
      expect(help.ok).toBe(true);
      expect(help.grid.some((line) => /1-4 select an inspector tab in Tree/.test(line))).toBe(true);
      // Esc closes it. The mode stays mounted under the overlay (the tab
      // bar is visible the whole time), so poll for the overlay text to
      // DISAPPEAR rather than for the mode to appear.
      await pane.send("\x1b");
      let overlayGone = false;
      let closedGrid = [];
      for (let i = 0; i < 25; i += 1) {
        closedGrid = await pane.grid();
        if (!closedGrid.some((line) => /Keybindings/.test(line))) {
          overlayGone = true;
          break;
        }
        await sleep(400);
      }
      expect(overlayGone).toBe(true);
      expect(closedGrid.some((line) => /output\s+logs\s+diff\s+props/.test(line))).toBe(true);

      // Resize below the compact threshold (100 cols): the monitor
      // re-renders inside the new width with the compact keybar format.
      await rpc("session.resize", { sessionId, cols: 70, rows: 24 });
      await sleep(1500);
      const captured = await rpc("session.capture", { sessionId, lines: 800 });
      const narrow = emulate(captured.text, 70, 24);
      expect(narrow.some((line) => /e2e-approval-probe/.test(line))).toBe(true);
      expect(narrow.some((line) => /\[g\]Graph/.test(line))).toBe(true);

      // q quits the monitor: the interactive flow prints its post-run
      // summary and leaves the (still-parked) run behind for reattach.
      await pane.send("q");
      const summary = await until(
        async () => emulate((await rpc("session.capture", { sessionId, lines: 800 })).text, 70, 24),
        /runId: run-/,
        { tries: 25, delayMs: 400 },
      );
      expect(summary.ok).toBe(true);
    } finally {
      await cancelLatestRun("e2e-approval-probe", testStartedAtMs, gatewayPort, iso.env);
      if (sessionId) {
        await rpc("session.terminate", { sessionId }).catch(() => {});
      }
      await stop();
      await stopGatewayPort(gatewayPort);
      iso.cleanup();
    }
  }, 240_000);

  test("tree inspector tabs 1-4 switch output/logs/diff/props", async () => {
    const cols = 100;
    const rows = 30;
    const testStartedAtMs = Date.now();
    const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-mon-tabs", idleSeconds: 240 });
    const gatewayPort = await freePort();
    const iso = isolatedGatewayEnv(gatewayPort);
    let sessionId;
    let runId = null;
    try {
      const created = await rpc("session.create", {
        command: interactiveCommand(iso),
        cwd: REPO_ROOT,
        cols,
        rows,
      });
      sessionId = created.id;
      const started = await startParkedMonitor(rpc, sessionId, { cols, rows });
      const { pane } = started;
      runId = started.runId;

      // The inspector defaults to the props tab: the focused root's
      // props JSON (id/key/kind/…/childIds) is visible.
      const props = await until(pane.grid, /"childIds"/);
      expect(props.ok).toBe(true);
      expect(props.grid.some((line) => /"kind": "workflow"/.test(line))).toBe(true);

      // 1 → output. The parked workflow root has produced nothing yet.
      await pane.send("1");
      const output = await until(pane.grid, /\(no output\)/);
      expect(output.ok).toBe(true);

      // 2 → logs (node-scoped log events).
      await pane.send("2");
      const logsTab = await until(pane.grid, /\(no log events for this node\)|^\s+\[\d+\] /);
      if (!logsTab.ok) throw new Error(`logs tab never rendered\n${logsTab.grid.join("\n")}`);

      // 3 → diff. A static probe run makes no file changes; an RPC error
      // surfaces distinctly as "Diff unavailable: …".
      await pane.send("3");
      const diffTab = await until(
        pane.grid,
        /No diff available for this node|No file changes for this node iteration|Loading diff|Diff unavailable:/,
      );
      expect(diffTab.ok).toBe(true);

      // 4 → back to props.
      await pane.send("4");
      const propsAgain = await until(pane.grid, /"childIds"/);
      expect(propsAgain.ok).toBe(true);
    } finally {
      await cancelLatestRun("e2e-approval-probe", testStartedAtMs, gatewayPort, iso.env);
      if (sessionId) {
        await rpc("session.terminate", { sessionId }).catch(() => {});
      }
      await stop();
      await stopGatewayPort(gatewayPort);
      iso.cleanup();
    }
  }, 240_000);

  test("approving the gate from the TUI completes the run", async () => {
    const cols = 100;
    const rows = 30;
    const testStartedAtMs = Date.now();
    const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-mon-approve", idleSeconds: 300 });
    const gatewayPort = await freePort();
    const iso = isolatedGatewayEnv(gatewayPort);
    let sessionId;
    let runId = null;
    try {
      const created = await rpc("session.create", {
        command: interactiveCommand(iso),
        cwd: REPO_ROOT,
        cols,
        rows,
      });
      sessionId = created.id;
      const started = await startParkedMonitor(rpc, sessionId, { cols, rows });
      const { pane } = started;
      runId = started.runId;
      expect(runId).not.toBeNull();

      // Focus the paused gate node so the approval banner (and its [a]
      // hotkey) is active, then approve.
      let bannerShown = false;
      let g = [];
      for (let i = 0; i < 120 && !pane.isDead(); i += 1) {
        g = await pane.grid();
        if (g.some((line) => /\[a\] approve/i.test(line))) {
          bannerShown = true;
          break;
        }
        if (i % 3 === 0) await pane.send(KEY.down);
        await sleep(500);
      }
      if (!bannerShown) throw new Error(`approval banner never became active\n${g.join("\n")}`);
      await pane.send("a");

      // The approval releases the gated task; the run must reach a real
      // terminal success in the workspace DB (not just banner dismissal).
      // The run-row status for a successful run is "finished" (its state
      // column is "succeeded"); listRuns reports the former.
      let status = "none";
      for (let i = 0; i < 180; i += 1) {
        // Generous RPC timeout: a workspace-scale gateway (dozens of
        // registered workflows over a large store) can take >1s to
        // answer listRuns; a short timeout reads as "none" forever.
        const frame = await gatewayRpc(gatewayPort, "listRuns", { limit: 50 }, 8_000);
        if (frame?.type === "res" && frame.ok && Array.isArray(frame.payload)) {
          const probe = frame.payload
            .filter((r) => r.workflowName === "e2e-approval-probe" && r.createdAtMs >= testStartedAtMs)
            .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
          status = probe?.status ?? "none";
          if (status === "finished" || status === "failed" || status === "cancelled") break;
        }
        await pane.grid();
        await sleep(1_000);
      }
      expect(status).toBe("finished");
      runId = null; // completed — nothing to cancel
    } finally {
      await cancelLatestRun("e2e-approval-probe", testStartedAtMs, gatewayPort, iso.env);
      if (sessionId) {
        await rpc("session.terminate", { sessionId }).catch(() => {});
      }
      await stop();
      await stopGatewayPort(gatewayPort);
      iso.cleanup();
    }
  }, 300_000);
});

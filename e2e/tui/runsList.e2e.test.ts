import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultSeed, startSeededGateway, type SeededGateway } from "../../packages/tui/tests/seededGateway.ts";
import { describeZmux } from "./zmux/zmuxBin.ts";
import { startDaemon, type ZmuxDaemon } from "./zmux/zmuxDaemon.ts";
import { ZmuxClient } from "./zmux/zmuxClient.ts";
import { createSession, sendKey, sendText, terminateSession } from "./zmux/zmuxRpc.ts";
import { waitForCaptureContains } from "./zmux/zmuxWait.ts";

/**
 * Phase 2 exit criterion (research/tui-parity/03-tui-screens.md "Runs list"):
 * a seeded gateway with 2 runs; assert both run ids render in Runs mode; Enter
 * on a row shows that run's tree. Boots the real `smithers-mon` binary under a
 * fixed 80x24 pty (06-zmux-harness.md), against a REAL in-process gateway
 * (seededGateway.ts) — not a mock of the TUI's data client.
 */
const REPO_ROOT = join(import.meta.dir, "../..");
const TUI_ENTRY = join(REPO_ROOT, "packages/tui/src/index.tsx");
const RUN_ID = "tp-runs-e2e-a";
const OTHER_RUN_ID = "tp-runs-e2e-b";

describeZmux("Runs mode lists runs and navigates into a run's tree", () => {
  let daemon: ZmuxDaemon;
  let client: ZmuxClient;

  beforeAll(async () => {
    daemon = await startDaemon();
    client = new ZmuxClient(daemon.socketPath);
    await client.ready();
  });

  afterAll(async () => {
    client?.close();
    await daemon?.dispose();
  });

  test("renders both run ids and Enter opens the tree", async () => {
    let seeded: SeededGateway | undefined;
    let paneId: string | undefined;
    try {
      const seed = defaultSeed(RUN_ID);
      // No workflowKey on either row: runsList.ts's toRunSummary falls back to
      // the bare runId as the display name, so asserting on RUN_ID/OTHER_RUN_ID
      // in the capture directly proves the roster rendered, not a workflow label.
      seed.runsList = [
        { runId: RUN_ID, status: "running", startedAtMs: Date.now() - 5000 },
        { runId: OTHER_RUN_ID, status: "running", startedAtMs: Date.now() - 9000 },
      ];
      // OTHER_RUN_ID gets its OWN distinct tree (a bare root the shared
      // defaultSeed() snapshot never uses), so "Enter opens the tree" proves a
      // real navigation happened instead of just re-showing content that was
      // already on screen before Runs mode was ever entered — session.capture
      // is a raw PTY byte ring (06-zmux-harness.md), so earlier frames' text
      // stays matchable for the rest of the test and can't be used to prove
      // something left the screen.
      seed.runSnapshots = {
        [OTHER_RUN_ID]: {
          runState: { state: "running" },
          // snapshotToGatewayRunNode's nodeName() prefers task.label over the
          // SnapshotNode's own `name` field, so the label must live there for
          // the row to actually render "other-run-root".
          root: { id: 0, name: "other-run-root", type: "workflow", task: { nodeId: "root", label: "other-run-root" } },
        },
      };
      seeded = startSeededGateway(seed);

      const session = await createSession(client, {
        command: `${process.execPath} ${TUI_ENTRY} ${RUN_ID} --gateway ${seeded.baseUrl}`,
        rows: 24,
        cols: 80,
        title: "smithers-mon-runs-list-e2e",
        env: {
          TERM: "xterm-256color",
          NO_COLOR: "1",
          CI: "1",
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          SMITHERS_GATEWAY_URL: seeded.baseUrl,
        },
      });
      paneId = session.paneId;

      // Boots straight into Tree mode on RUN_ID (unchanged smithers-mon
      // behavior — see App.tsx's activeRunId starting at the CLI runId).
      await waitForCaptureContains(client, paneId, RUN_ID, 15000);

      // "r" (routeAppKey's Runs alias) switches to Runs mode.
      await sendText(client, paneId, "r");
      await waitForCaptureContains(client, paneId, "RUNS", 15000);
      // Both seeded run ids render as roster rows.
      await waitForCaptureContains(client, paneId, RUN_ID, 5000);
      await waitForCaptureContains(client, paneId, OTHER_RUN_ID, 5000);

      // Move focus onto the second row (OTHER_RUN_ID is seeded second, so one
      // "j" lands on it) and open it — proves navigation actually switches the
      // active run, not just re-showing the run smithers-mon booted with.
      await sendText(client, paneId, "j");
      await sendKey(client, paneId, "Enter");

      // Enter returns to Tree mode (App's onSelectRun sets mode 1) showing
      // OTHER_RUN_ID's own distinct root node — a string that could only
      // appear once Enter actually switched the active run and opened its tree.
      await waitForCaptureContains(client, paneId, "other-run-root", 15000);

      // "q" tears the renderer down and exits 0.
      await sendText(client, paneId, "q");
      paneId = undefined;
    } finally {
      if (paneId) await terminateSession(client, paneId).catch(() => {});
      seeded?.stop();
    }
  }, 45000);
});

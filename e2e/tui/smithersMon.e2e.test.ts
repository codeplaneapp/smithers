import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultSeed, startSeededGateway, type SeededGateway } from "../../packages/tui/tests/seededGateway.ts";
import { describeZmux } from "./zmux/zmuxBin.ts";
import { startDaemon, type ZmuxDaemon } from "./zmux/zmuxDaemon.ts";
import { ZmuxClient } from "./zmux/zmuxClient.ts";
import { createSession, sendText, terminateSession } from "./zmux/zmuxRpc.ts";
import { waitForCaptureContains, waitForSessionExited } from "./zmux/zmuxWait.ts";

/**
 * Phase 1 exit criterion (research/tui-parity/06-zmux-harness.md): boot the
 * real `smithers-mon` binary under a fixed 80x24 pty against a seeded local
 * gateway, assert the header renders, open/close the help overlay, then quit
 * and confirm a clean exit. The gateway is a REAL in-process HTTP server
 * speaking the exact wire contract (see seededGateway.ts) — not a mock of the
 * TUI's data client.
 */
const REPO_ROOT = join(import.meta.dir, "../..");
const TUI_ENTRY = join(REPO_ROOT, "packages/tui/src/index.tsx");
const RUN_ID = "tui-parity-boot-e2e";

describeZmux("smithers-mon boots under zmux", () => {
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

  test("renders the run header, opens help, and quits cleanly", async () => {
    let seeded: SeededGateway | undefined;
    let paneId: string | undefined;
    try {
      seeded = startSeededGateway(defaultSeed(RUN_ID));

      const session = await createSession(client, {
        command: `${process.execPath} ${TUI_ENTRY} ${RUN_ID} --gateway ${seeded.baseUrl}`,
        rows: 24,
        cols: 80,
        title: "smithers-mon-e2e",
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

      // 80 cols is below packages/tui's COMPACT_WIDTH (100), so the header
      // renders its compact form: `● <shortRunId> <status> [<live>]` with no
      // workflow name (see Header.tsx's RunHeaderView `compact` branch).
      // Generous timeout: this spins up bun + opentui's native renderer fresh.
      await waitForCaptureContains(client, paneId, RUN_ID, 15000);

      // "?" toggles the help overlay, whose panel title is "Keybindings". Plain
      // printable characters go through session.send, not session.sendKey
      // (sendKey is for named/control keys only — see 06-zmux-harness.md #7).
      await sendText(client, paneId, "?");
      await waitForCaptureContains(client, paneId, "Keybindings", 15000);

      // "q" (routed through routeAppKey) tears the renderer down and exits 0.
      await sendText(client, paneId, "q");
      const exited = await waitForSessionExited(client, paneId, { expectExitCode: 0, timeoutMs: 15000 });
      expect(exited.exit_code).toBe(0);
      paneId = undefined; // process already exited; nothing left to terminate.
    } finally {
      if (paneId) await terminateSession(client, paneId).catch(() => {});
      seeded?.stop();
    }
  }, 45000);
});

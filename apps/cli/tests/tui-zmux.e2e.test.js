// Real-PTY e2e for the interactive run flow (`smithers up --interactive`),
// driven through zmux (github.com/smithersai/zmux). Each test spawns the zmux
// daemon, runs `smithers up --interactive` inside an 80x24 pane, drives the
// clack prompts with raw key bytes, and asserts against the visible terminal
// grid reconstructed by the VT emulator in zmux-harness.js.
//
// The `zmuxd` daemon binary is NOT present on the clean CI box by default. When
// `resolveZmuxd()` returns null these tests skip cleanly so CI stays green;
// CI installs the daemon, exports ZMUXD, and runs them explicitly.
import { describe, expect, test } from "bun:test";
import {
    REPO_ROOT,
    KEY,
    b64,
    sleep,
    resolveZmuxd,
    startDaemon,
    emulate,
    activeRows,
    activeLabel,
    freePort,
    gatewayRpc,
    stopGatewayPort,
    cancelVisibleRun,
    navigateToWorkflow,
    paneDriver,
} from "./zmux-harness.js";

const ZMUXD = resolveZmuxd();
// Agent harnesses often run inside a nested PTY with a real zmuxd on PATH; that
// environment is not stable enough for these real-terminal assertions.
const AGENT_HARNESS = Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CODEX_CI);
// `bun apps/cli/src/index.js up --interactive` from the repo root is the most
// robust way to launch the interactive flow inside the pane (avoids depending on
// the `bun run cli` script). With no workflow argument it opens the picker.
const TUI_COMMAND = "bun apps/cli/src/index.js up --interactive";

const commandForGatewayPort = (port) => `env SMITHERS_GATEWAY_PORT=${port} ${TUI_COMMAND}`;

describe.skipIf(ZMUXD == null || AGENT_HARNESS)("smithers up --interactive zmux PTY", () => {
    test("renders the workflow picker without wrapped ghost rows", async () => {
        const cols = 80;
        const rows = 20;
        const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-smithers-tui" });
        const gatewayPort = await freePort();
        let sessionId;
        try {
            await rpc("daemon.ping", {});

            const created = await rpc("session.create", {
                command: commandForGatewayPort(gatewayPort),
                cwd: REPO_ROOT,
                cols,
                rows,
            });
            sessionId = created.id;

            const capture = async () => (await rpc("session.capture", { sessionId, lines: 400 })).text;
            const send = (keys) => rpc("session.send", { sessionId, dataBase64: b64(keys) });

            let raw = "";
            for (let i = 0; i < 60; i += 1) {
                await sleep(250);
                raw = await capture();
                if (raw.includes("Select a workflow to run")) break;
            }
            const initialGrid = emulate(raw, cols, rows);

            for (let i = 0; i < 12; i += 1) {
                await send(KEY.down);
                await sleep(100);
            }
            const afterGrid = emulate(await capture(), cols, rows);

            await send(KEY.ctrlC).catch(() => {});
            await sleep(200);

            const initialActive = activeRows(initialGrid);
            const afterActive = activeRows(afterGrid);
            const initialLabel = activeLabel(initialGrid);
            const afterLabel = activeLabel(afterGrid);

            expect(initialGrid.some((line) => line.includes("Select a workflow to run"))).toBe(true);
            expect(initialActive).toHaveLength(1);
            expect(afterActive).toHaveLength(1);
            expect(afterGrid.every((line) => line.length <= cols)).toBe(true);
            expect(afterLabel.length).toBeGreaterThan(0);
            expect(afterLabel).not.toBe(initialLabel);
        } finally {
            if (sessionId) {
                await rpc("session.terminate", { sessionId }).catch(() => {});
            }
            await stop();
            await stopGatewayPort(gatewayPort);
        }
    }, 30_000);

    test("workflow picker filters by typing", async () => {
        const cols = 80;
        const rows = 20;
        const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-smithers-tui-filter" });
        const gatewayPort = await freePort();
        let sessionId;
        try {
            const created = await rpc("session.create", {
                command: commandForGatewayPort(gatewayPort),
                cwd: REPO_ROOT,
                cols,
                rows,
            });
            sessionId = created.id;

            const capture = async () => (await rpc("session.capture", { sessionId, lines: 400 })).text;
            const send = (keys) => rpc("session.send", { sessionId, dataBase64: b64(keys) });

            let raw = "";
            for (let i = 0; i < 60; i += 1) {
                await sleep(250);
                raw = await capture();
                if (raw.includes("Select a workflow to run")) break;
            }

            await send("e2e");
            await sleep(300);
            const grid = emulate(await capture(), cols, rows);

            await send(KEY.ctrlC).catch(() => {});
            await sleep(200);

            expect(grid.some((line) => line.includes("Select a workflow to run"))).toBe(true);
            expect(activeRows(grid)).toHaveLength(1);
            expect(activeLabel(grid)).toMatch(/e2e/i);
            expect(grid.every((line) => line.length <= cols)).toBe(true);
        } finally {
            if (sessionId) {
                await rpc("session.terminate", { sessionId }).catch(() => {});
            }
            await stop();
            await stopGatewayPort(gatewayPort);
        }
    }, 30_000);

    test("reasks on invalid integer input then advances on a valid value", async () => {
        const cols = 80;
        const rows = 24;
        const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-smithers-tui-in" });
        const gatewayPort = await freePort();
        let sessionId;
        try {
            const created = await rpc("session.create", {
                command: commandForGatewayPort(gatewayPort),
                cwd: REPO_ROOT,
                cols,
                rows,
            });
            sessionId = created.id;

            const grid = async () => emulate((await rpc("session.capture", { sessionId, lines: 400 })).text, cols, rows);
            const send = (keys) => rpc("session.send", { sessionId, dataBase64: b64(keys) });
            const active = (g) => activeLabel(g);

            // 1) type-to-filter to "Dynamic Task Demo" (has integer inputs) → select
            let g = [];
            const reached = await navigateToWorkflow(send, grid, "dynamic task", /dynamic task demo/i);
            expect(reached).toBe(true);
            await send(KEY.enter);
            await sleep(700);

            // 3) the first integer input prompt should appear
            let promptShown = false;
            for (let i = 0; i < 30; i += 1) {
                g = await grid();
                if (g.some((line) => /delayMs/i.test(line))) {
                    promptShown = true;
                    break;
                }
                await sleep(200);
            }

            // 4) type an invalid (non-number) value → expect a reask validation error
            await send("abc");
            await sleep(150);
            await send(KEY.enter);
            await sleep(400);
            const afterInvalid = await grid();
            const reasked = afterInvalid.some((line) => /whole number|number/i.test(line));

            // 5) correct it to a valid number → expect the error to clear / advance
            await send(KEY.ctrlU);
            await sleep(80);
            await send("5");
            await sleep(120);
            await send(KEY.enter);
            await sleep(500);
            const afterValid = await grid();
            const advanced = !afterValid.some((line) => /whole number/i.test(line));

            await send(KEY.ctrlC).catch(() => {});
            await sleep(300);

            expect(reached).toBe(true);
            expect(promptShown).toBe(true);
            expect(reasked).toBe(true);
            expect(advanced).toBe(true);
        } finally {
            if (sessionId) {
                await rpc("session.terminate", { sessionId }).catch(() => {});
            }
            await stop();
            await stopGatewayPort(gatewayPort);
        }
    }, 60_000);

    test("approval gate shows the pending approval node in the monitor", async () => {
        const cols = 80;
        const rows = 24;
        const testStartedAtMs = Date.now();
        const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-smithers-tui-ap", idleSeconds: 180 });
        const gatewayPort = await freePort();
        let sessionId;
        try {
            const created = await rpc("session.create", {
                command: commandForGatewayPort(gatewayPort),
                cwd: REPO_ROOT,
                cols,
                rows,
            });
            sessionId = created.id;

            const { grid, send, isDead } = paneDriver(rpc, sessionId, { cols, rows });
            const has = (g, re) => g.some((line) => re.test(line));

            // 1) picker → type-to-filter to "E2E Approval Probe" → select
            let g = [];
            const reached = await navigateToWorkflow(send, grid, "approval probe", /e2e approval probe/i);
            expect(reached).toBe(true);
            await send(KEY.enter);
            await sleep(800);

            // 2) run starts and pauses at the Approval gate → focus the paused node
            // so the monitor hotkeys act on the pending approval row.
            let status = "none";
            let approvalShown = false;
            for (let i = 0; i < 180 && !isDead(); i += 1) {
                g = await grid();
                if (
                    has(g, /Approve E2E gated task/i) &&
                    (has(g, /\[a\] approve/i) || has(g, /"kind": "approval"/i))
                ) {
                    approvalShown = true;
                    break;
                }
                // The monitor initially focuses the workflow root; move to the
                // paused child node so the approval banner and hotkeys are active.
                if (i % 4 === 0) await send(KEY.down);
                await sleep(500);
            }
            if (!approvalShown) {
                status = await latestProbeStatus("e2e-approval-probe", testStartedAtMs, gatewayPort);
                throw new Error(`approval node not visible; status=${status}; dead=${isDead()}\n${g.join("\n")}`);
            }
            await cancelVisibleRun(g, gatewayPort);

            if (!isDead()) {
                await send(KEY.ctrlC);
                await sleep(200);
            }

            expect(reached).toBe(true);
            expect(approvalShown).toBe(true);
        } finally {
            if (sessionId) {
                await rpc("session.terminate", { sessionId }).catch(() => {});
            }
            await stop();
            await stopGatewayPort(gatewayPort);
        }
    }, 180_000);

    test("human request gate shows CLI answer guidance", async () => {
        const cols = 80;
        const rows = 24;
        const testStartedAtMs = Date.now();
        const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-smithers-tui-human", idleSeconds: 180 });
        const gatewayPort = await freePort();
        let sessionId;
        try {
            const created = await rpc("session.create", {
                command: commandForGatewayPort(gatewayPort),
                cwd: REPO_ROOT,
                cols,
                rows,
            });
            sessionId = created.id;

            const { grid, send, isDead } = paneDriver(rpc, sessionId, { cols, rows });
            const has = (g, re) => g.some((line) => re.test(line));

            // type-to-filter to "E2E Ask Human Probe" → select
            let g = [];
            const reached = await navigateToWorkflow(send, grid, "ask human probe", /e2e ask human probe/i);
            expect(reached).toBe(true);
            await send(KEY.enter);
            await sleep(800);

            let promptShown = false;
            let status = "none";
            for (let i = 0; i < 180 && !isDead(); i += 1) {
                g = await grid();
                if (has(g, /\[human input\]/i) || has(g, /smithers human inbox/i)) {
                    promptShown = true;
                }
                // The monitor starts on the workflow root; the human-request
                // guidance renders once the paused HumanTask row is focused.
                if (i % 4 === 0) await send(KEY.down);
                status = await latestProbeStatus("e2e-ask-human-probe", testStartedAtMs, gatewayPort);
                if (promptShown && status === "waiting-approval") break;
                await sleep(500);
            }
            await cancelVisibleRun(g, gatewayPort);

            if (!isDead()) {
                await send(KEY.ctrlC);
                await sleep(200);
            }

            if (!promptShown) {
                throw new Error(`human guidance not visible; status=${status}; dead=${isDead()}\n${g.join("\n")}`);
            }
            expect(status).toBe("waiting-approval");
        } finally {
            if (sessionId) {
                await rpc("session.terminate", { sessionId }).catch(() => {});
            }
            await stop();
            await stopGatewayPort(gatewayPort);
        }
    }, 180_000);
});

async function latestProbeStatus(workflowName, sinceMs, gatewayPort) {
    try {
        const frame = await gatewayRpc(gatewayPort, "listRuns", { limit: 50 }, 300);
        if (!frame || frame.type !== "res" || !frame.ok || !Array.isArray(frame.payload)) return "none";
        const probe = frame.payload
            .filter((r) => r.workflowName === workflowName && r.createdAtMs >= sinceMs)
            .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
        return probe?.status ?? "none";
    } catch {
        return "error";
    }
}

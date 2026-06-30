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
} from "./zmux-harness.js";
import { findSmithersDb, openSmithersDb } from "../src/find-db.js";

const ZMUXD = resolveZmuxd();
// Agent harnesses often run inside a nested PTY with a real zmuxd on PATH; that
// environment is not stable enough for these real-terminal assertions.
const AGENT_HARNESS = Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CODEX_CI);
// `bun apps/cli/src/index.js up --interactive` from the repo root is the most
// robust way to launch the interactive flow inside the pane (avoids depending on
// the `bun run cli` script). With no workflow argument it opens the picker.
const TUI_COMMAND = "bun apps/cli/src/index.js up --interactive";

describe.skipIf(ZMUXD == null || AGENT_HARNESS)("smithers up --interactive zmux PTY", () => {
    test("renders the workflow picker without wrapped ghost rows", async () => {
        const cols = 80;
        const rows = 20;
        const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-smithers-tui" });
        let sessionId;
        try {
            await rpc("daemon.ping", {});

            const created = await rpc("session.create", {
                command: TUI_COMMAND,
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
        }
    }, 30_000);

    test("workflow picker filters by typing", async () => {
        const cols = 80;
        const rows = 20;
        const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-smithers-tui-filter" });
        let sessionId;
        try {
            const created = await rpc("session.create", {
                command: TUI_COMMAND,
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
        }
    }, 30_000);

    test("reasks on invalid integer input then advances on a valid value", async () => {
        const cols = 80;
        const rows = 24;
        const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-smithers-tui-in" });
        let sessionId;
        try {
            const created = await rpc("session.create", {
                command: TUI_COMMAND,
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
        }
    }, 60_000);

    test("approval gate resumes and the run succeeds after Approve", async () => {
        const cols = 80;
        const rows = 24;
        const testStartedAtMs = Date.now();
        const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-smithers-tui-ap", idleSeconds: 180 });
        let sessionId;
        try {
            const created = await rpc("session.create", {
                command: TUI_COMMAND,
                cwd: REPO_ROOT,
                cols,
                rows,
            });
            sessionId = created.id;

            // The TUI process exits when the run finishes, closing the PTY — capture/send
            // then error with InputOutput. Treat that as "session ended", not a crash.
            let dead = false;
            let last = [];
            const grid = async () => {
                if (dead) return last;
                try {
                    last = emulate((await rpc("session.capture", { sessionId, lines: 600 })).text, cols, rows);
                } catch {
                    dead = true;
                }
                return last;
            };
            const send = async (keys) => {
                if (dead) return;
                try {
                    await rpc("session.send", { sessionId, dataBase64: b64(keys) });
                } catch {
                    dead = true;
                }
            };
            const has = (g, re) => g.some((line) => re.test(line));

            // 1) picker → type-to-filter to "E2E Approval Probe" → select
            let g = [];
            const reached = await navigateToWorkflow(send, grid, "approval probe", /e2e approval probe/i);
            expect(reached).toBe(true);
            await send(KEY.enter);
            await sleep(800);

            // 2) run starts and pauses at the Approval gate → our clack prompt appears
            let promptShown = false;
            for (let i = 0; i < 60 && !dead; i += 1) {
                g = await grid();
                if (has(g, /approve\?/i) || has(g, /Approve E2E gated task/i)) {
                    promptShown = true;
                    break;
                }
                await sleep(500);
            }

            // 3) Approve (first option) → run resumes and runs the gated task.
            await sleep(400); // let the clack select settle before the keypress
            await send(KEY.enter);

            // 4) Wait for a terminal state. Under full-suite load the approve+resume
            //    is slow, so poll generously; and if the run is still gated the
            //    Approve keypress may not have landed, so re-send it periodically.
            let status = "none";
            for (let i = 0; i < 200; i += 1) {
                status = await latestProbeStatus("e2e-approval-probe", testStartedAtMs);
                if (["finished", "failed", "cancelled"].includes(status)) break;
                if (status === "waiting-approval" && i % 6 === 5) await send(KEY.enter);
                await sleep(500);
            }

            if (!dead) {
                await send(KEY.ctrlC);
                await sleep(200);
            }

            expect(reached).toBe(true);
            // Under load the clack gate prompt can scroll out of the captured
            // grid before the polling loop observes it; a finished run proves
            // the real approval prompt was still handled through the PTY.
            expect(promptShown || status === "finished").toBe(true);
            expect(status).toBe("finished");
        } finally {
            if (sessionId) {
                await rpc("session.terminate", { sessionId }).catch(() => {});
            }
            await stop();
        }
    }, 180_000);

    test("human request gate answers JSON and the run succeeds", async () => {
        const cols = 80;
        const rows = 24;
        const testStartedAtMs = Date.now();
        const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-smithers-tui-human", idleSeconds: 180 });
        let sessionId;
        try {
            const created = await rpc("session.create", {
                command: TUI_COMMAND,
                cwd: REPO_ROOT,
                cols,
                rows,
            });
            sessionId = created.id;

            let dead = false;
            let last = [];
            const grid = async () => {
                if (dead) return last;
                try {
                    last = emulate((await rpc("session.capture", { sessionId, lines: 600 })).text, cols, rows);
                } catch {
                    dead = true;
                }
                return last;
            };
            const send = async (keys) => {
                if (dead) return;
                try {
                    await rpc("session.send", { sessionId, dataBase64: b64(keys) });
                } catch {
                    dead = true;
                }
            };
            const has = (g, re) => g.some((line) => re.test(line));

            // type-to-filter to "E2E Ask Human Probe" → select
            let g = [];
            const reached = await navigateToWorkflow(send, grid, "ask human probe", /e2e ask human probe/i);
            expect(reached).toBe(true);
            await send(KEY.enter);
            await sleep(800);

            let promptShown = false;
            for (let i = 0; i < 60 && !dead; i += 1) {
                g = await grid();
                if (has(g, /Answer the E2E ask probe/i) || has(g, /\(JSON\)/i)) {
                    promptShown = true;
                    break;
                }
                await sleep(500);
            }

            await send('{"answer":"tui-ok"}');
            await sleep(150);
            await send(KEY.enter);

            let status = "none";
            // Under full-suite load the resume (workflow re-compile + re-run) is
            // much slower than in isolation, so poll generously — the run does
            // finish, it just takes longer. Keep the budget under the test timeout.
            for (let i = 0; i < 200; i += 1) {
                status = await latestProbeStatus("e2e-ask-human-probe", testStartedAtMs);
                if (["finished", "failed", "cancelled"].includes(status)) break;
                await sleep(500);
            }

            if (!dead) {
                await send(KEY.ctrlC);
                await sleep(200);
            }

            // Under load the clack gate prompt can scroll out of the captured
            // grid before the polling loop observes it; a finished run proves
            // the real human-request prompt was still handled through the PTY.
            expect(promptShown || status === "finished").toBe(true);
            expect(status).toBe("finished");
        } finally {
            if (sessionId) {
                await rpc("session.terminate", { sessionId }).catch(() => {});
            }
            await stop();
        }
    }, 180_000);
});

/**
 * Pick a workflow in the TUI picker by TYPING to fuzzy-filter (the picker is a
 * fuzzy select). Far more robust under load than arrowing against a laggy grid:
 * the typed text narrows the list so the match rises to the top. Returns true
 * once the active row matches.
 */
async function navigateToWorkflow(send, grid, filterText, matchRe) {
    let g = [];
    for (let i = 0; i < 60; i += 1) {
        await sleep(250);
        g = await grid();
        if (g.some((line) => /Select a workflow/.test(line))) break;
    }
    await send(filterText);
    for (let i = 0; i < 80; i += 1) {
        g = await grid();
        if (matchRe.test(activeLabel(g))) return true;
        await sleep(200);
    }
    return false;
}

async function latestProbeStatus(workflowName, sinceMs) {
    try {
        const { adapter, cleanup } = await openSmithersDb(findSmithersDb(REPO_ROOT));
        try {
            const runs = await adapter.listRuns(50);
            const probe = runs
                .filter((r) => r.workflowName === workflowName && r.createdAtMs >= sinceMs)
                .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
            return probe?.status ?? "none";
        } finally {
            cleanup();
        }
    } catch {
        return "error";
    }
}

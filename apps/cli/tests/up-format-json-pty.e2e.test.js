// Real-PTY e2e for finding #19: `smithers up --format json` (a machine-output
// request) must NEVER open the interactive clack picker, even on a TTY where
// the picker is the default for a missing workflow argument. Pre-fix, the
// picker's UI bytes interleaved with stdout and the process blocked on keys;
// post-fix the command takes the non-interactive missing-arg branch and exits
// 4 with a WORKFLOW_REQUIRED envelope.
//
// Driven through zmux like tui-zmux.e2e.test.js; skips cleanly when the zmuxd
// daemon is not installed (clean CI box) or inside an agent harness's nested
// PTY, which is not stable enough for real-terminal assertions.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, resolveZmuxd, startDaemon, sleep } from "./zmux-harness.js";

const ZMUXD = resolveZmuxd();
const AGENT_HARNESS = Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CODEX_CI);
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");

describe.skipIf(ZMUXD == null || AGENT_HARNESS)("up --format json on a real PTY (#19)", () => {
    test("emits the WORKFLOW_REQUIRED envelope instead of opening the workflow picker", async () => {
        // A workspace WITH discoverable workflows, so the pre-fix behavior
        // (interactive picker) would engage and block.
        const dir = mkdtempSync(join(tmpdir(), "smithers-pty-json-"));
        mkdirSync(join(dir, ".smithers", "workflows"), { recursive: true });
        writeFileSync(join(dir, ".smithers", "workflows", "hello.tsx"), "export default {};\n");
        const { rpc, stop } = await startDaemon(ZMUXD, { prefix: "zmx-smithers-up-json" });
        let sessionId;
        try {
            const created = await rpc("session.create", {
                command: `sh -c 'bun ${CLI_ENTRY} up --format json; echo PTY_EXIT_CODE=$?; sleep 30'`,
                cwd: dir,
                cols: 200,
                rows: 50,
            });
            sessionId = created.id;
            const capture = async () => (await rpc("session.capture", { sessionId, lines: 400 })).text;
            let raw = "";
            for (let i = 0; i < 80; i += 1) {
                await sleep(250);
                raw = await capture();
                if (raw.includes("PTY_EXIT_CODE=")) break;
            }
            expect(raw).toContain("PTY_EXIT_CODE=4");
            expect(raw).toContain("WORKFLOW_REQUIRED");
            // The blocking clack picker must not have rendered.
            expect(raw).not.toContain("Select a workflow");
        } finally {
            if (sessionId) {
                await rpc("session.terminate", { sessionId }).catch(() => {});
            }
            await stop();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 45_000);
});

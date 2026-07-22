import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as nodeChildProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Snapshot the REAL child_process module up front. Bun's mock.restore() does NOT
// undo a mock.module(), so afterAll must re-install this snapshot — otherwise the
// fake spawn leaks to every test file that runs after this one and crashes their
// spawn-based paths. This mirrors the scoping used by cron-command-scheduler.test.js.
const REAL_CHILD_PROCESS = { ...nodeChildProcess };
const { spawnSync } = nodeChildProcess;

/** @type {Array<{ command: string; args: string[]; options: Record<string, unknown> }>} */
const spawnCalls = [];
let spawnPid = 4242;

/** @type {typeof import("../src/resume-detached.js")} */
let resumeModule;

// Mock inside beforeAll (never at module top level): a top-level mock.module is
// applied at collection time and leaks GLOBALLY to every other test file whose
// bare `{ unref }` child has no `.once`/`.stdout`. Scoping it to this file's
// beforeAll → afterAll window keeps the fake local.
beforeAll(async () => {
    mock.module("node:child_process", () => ({
        ...REAL_CHILD_PROCESS,
        spawn(command, args, options) {
            spawnCalls.push({ command, args, options });
            return { pid: spawnPid, unref() {} };
        },
        spawnSync,
    }));
    resumeModule = await import("../src/resume-detached.js");
});

afterAll(() => {
    // Re-install the real module first — mock.restore() does not undo mock.module().
    mock.module("node:child_process", () => REAL_CHILD_PROCESS);
    mock.restore();
});

beforeEach(() => {
    spawnCalls.length = 0;
});

describe("resumeRunDetached", () => {
    test("spawns `smithers up --resume` detached, logs stdio to the run's detached log, and returns the child pid", () => {
        spawnPid = 7001;
        const wfDir = mkdtempSync(join(tmpdir(), "smithers-resume-detached-"));
        try {
            const workflowPath = join(wfDir, "workflow.tsx");
            const pid = resumeModule.resumeRunDetached(workflowPath, "run-abc");
            expect(pid).toBe(7001);
            expect(spawnCalls).toHaveLength(1);
            const call = spawnCalls[0];
            expect(call.command).toBe("bun");
            // The CLI entry, the `up` verb, the workflow path, and the resume flags.
            expect(call.args).toContain("up");
            expect(call.args).toContain(workflowPath);
            expect(call.args).toContain("--resume");
            expect(call.args).toContain("--run-id");
            expect(call.args).toContain("run-abc");
            expect(call.args).toContain("-d");
            expect(call.args).toContain("--force");
            // No claim → none of the claim flags are present.
            expect(call.args).not.toContain("--resume-claim-owner");
            // Detached + cwd is the workflow's directory.
            expect(call.options).toMatchObject({ detached: true });
            expect(String(call.options.cwd)).toBe(wfDir);
            // stdout/stderr go to the run's managed detached log, NOT "ignore":
            // a resume that crashes at startup must leave a diagnosable trace
            // (issue #1361).
            const stdio = call.options.stdio;
            expect(Array.isArray(stdio)).toBe(true);
            expect(stdio[0]).toBe("ignore");
            expect(typeof stdio[1]).toBe("number");
            expect(stdio[2]).toBe(stdio[1]);
            const logFile = resumeModule.resumeRunDetachedLogFile(workflowPath, "run-abc");
            expect(logFile.endsWith(join(".smithers", "logs", "run-abc.log"))).toBe(true);
            expect(existsSync(logFile)).toBe(true);
        }
        finally {
            rmSync(wfDir, { recursive: true, force: true });
        }
    });

    test("falls back to discarded stdio when the log location is unusable", () => {
        spawnPid = 7005;
        const wfDir = mkdtempSync(join(tmpdir(), "smithers-resume-detached-"));
        try {
            // Make `<root>/.smithers/logs` a FILE so the log dir cannot be
            // created: the resume must still spawn, with output discarded.
            mkdirSync(join(wfDir, ".smithers"), { recursive: true });
            writeFileSync(join(wfDir, ".smithers", "logs"), "not a directory");
            const pid = resumeModule.resumeRunDetached(join(wfDir, "workflow.tsx"), "run-nolog");
            expect(pid).toBe(7005);
            expect(spawnCalls).toHaveLength(1);
            expect(spawnCalls[0].options.stdio).toBe("ignore");
        }
        finally {
            rmSync(wfDir, { recursive: true, force: true });
        }
    });

    test("appends the full claim (owner + heartbeat + restore owner/heartbeat)", () => {
        spawnPid = 7002;
        const pid = resumeModule.resumeRunDetached("workflow.tsx", "run-xyz", {
            claimOwnerId: "owner-1",
            claimHeartbeatAtMs: 111,
            restoreRuntimeOwnerId: "restore-owner",
            restoreHeartbeatAtMs: 222,
        });
        expect(pid).toBe(7002);
        const call = spawnCalls[0];
        expect(call.args).toEqual(
            expect.arrayContaining([
                "--resume-claim-owner", "owner-1",
                "--resume-claim-heartbeat", "111",
                "--resume-restore-owner", "restore-owner",
                "--resume-restore-heartbeat", "222",
            ]),
        );
    });

    test("omits the restore-owner/heartbeat flags when they are null or undefined", () => {
        spawnPid = 7003;
        resumeModule.resumeRunDetached("workflow.tsx", "run-x", {
            claimOwnerId: "owner-2",
            claimHeartbeatAtMs: 5,
            restoreRuntimeOwnerId: null,
            restoreHeartbeatAtMs: undefined,
        });
        const call = spawnCalls[0];
        expect(call.args).toContain("--resume-claim-owner");
        expect(call.args).not.toContain("--resume-restore-owner");
        expect(call.args).not.toContain("--resume-restore-heartbeat");
    });

    test("returns null when the spawned child exposes no pid", () => {
        spawnPid = undefined;
        const pid = resumeModule.resumeRunDetached("workflow.tsx", "run-nopid");
        expect(pid).toBeNull();
    });
});

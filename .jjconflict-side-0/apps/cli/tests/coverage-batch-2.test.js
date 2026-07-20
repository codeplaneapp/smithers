import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    asArray,
    formatEventLine,
    formatOutputValue,
    timeAgo,
} from "../src/monitor-ui/monitorModel.ts";
import { reportReplayResult } from "../src/reportReplayResult.js";
import { launchPostFailureAutopsy } from "../src/launchPostFailureAutopsy.js";
import { parseAgentWiringArgv } from "../src/agent-wiring/parseAgentWiringArgv.js";
import { registerHermesMcp } from "../src/agent-wiring/registerHermesMcp.js";

const tempDirs = [];
function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}
afterEach(() => {
    while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("monitorModel pure helpers", () => {
    test("asArray tolerates malformed JSON array strings", () => {
        expect(asArray("[not json")).toEqual([]);
        expect(asArray('["a","b"]')).toEqual(["a", "b"]);
        expect(asArray(["x"])).toEqual(["x"]);
        expect(asArray(42)).toEqual([]);
    });

    test("timeAgo covers minute, hour, and day scales", () => {
        const now = 1_000_000_000_000;
        expect(timeAgo(now - 5_000, now)).toBe("just now");
        expect(timeAgo(now - 5 * 60_000, now)).toBe("5m ago");
        expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
        expect(timeAgo(now - 2 * 86_400_000, now)).toBe("2d ago");
    });

    test("formatEventLine appends a run.completed status distinct from the state", () => {
        const line = formatEventLine({ seq: 9, event: "run.completed", payload: { state: "running", status: "finished" } });
        expect(line.detail).toContain("finished");
        expect(line.detail).toContain("running");
    });

    test("formatOutputValue falls back to the raw string on invalid JSON", () => {
        expect(formatOutputValue("{not json}")).toBe("{not json}");
    });
});

describe("reportReplayResult", () => {
    test("prints the VCS-not-restored line on error", () => {
        const lines = [];
        reportReplayResult({
            result: { runId: "r2", vcsError: "dirty tree" },
            parentRunId: "r1",
            parentFrame: 4,
            stderr: { write: (s) => lines.push(s) },
        });
        expect(lines.join("")).toContain("VCS state was not restored: dirty tree");
    });
});

describe("launchPostFailureAutopsy not-installed", () => {
    test("reports not-installed when the post-failure workflow cannot be resolved", () => {
        const root = tempDir("autopsy-");
        const lines = [];
        const result = launchPostFailureAutopsy({
            failedRunId: "run-x",
            cwd: root,
            env: { HOME: root, PATH: "" },
            write: (line) => lines.push(line),
        });
        expect(result).toEqual({ launched: false, reason: "not-installed" });
        expect(lines.join("")).toContain("post-failure workflow is not installed");
    });
});

describe("parseAgentWiringArgv --agent forms", () => {
    test("collects repeated --agent and --agent= values, ignoring an empty --agent", () => {
        const result = parseAgentWiringArgv(["mcp", "add", "--agent", "claude", "--agent=codex"]);
        expect(result.agents).toEqual(["claude", "codex"]);
        const trailing = parseAgentWiringArgv(["mcp", "add", "--agent"]);
        expect(trailing.agents ?? []).toEqual([]);
    });
});

describe("registerHermesMcp unparseable config", () => {
    test("reports unparseable-config when config parses to a non-object", () => {
        const home = tempDir("hermes-mcp-");
        mkdirSync(join(home, ".hermes"), { recursive: true });
        writeFileSync(join(home, ".hermes", "config.yaml"), "- a\n- b\n");
        const result = registerHermesMcp({ command: "smithers", args: ["mcp"], homeDir: home });
        expect(result).toMatchObject({ registered: false, reason: "unparseable-config" });
    });
});

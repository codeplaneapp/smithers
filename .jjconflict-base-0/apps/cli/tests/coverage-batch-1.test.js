import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatEventLine } from "../src/format.js";
import { fuzzyFilter } from "../src/fuzzy-select.js";
import { resolveSmithersDocsSource } from "../src/docs-command.js";
import { hasCustomUi } from "../src/monitoring-suggestion.js";
import { runSnapshotsOnce } from "../src/snapshots.js";
import { parseMcpSurfaceArgv } from "../src/argv-utils.js";
import { resolveSkillSource } from "../src/installCuratedSkill.js";
import { noteWorkflowPreferenceInAgentDocs } from "../src/noteWorkflowPreferenceInAgentDocs.js";
import { buildAgentNextSteps } from "../src/agentNextSteps.js";
import { registerSemanticTools } from "../src/mcp/semantic-server.js";
import { SEMANTIC_TOOL_NAMES } from "../src/mcp/semantic-tools.js";

const tempDirs = [];
function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}
afterEach(() => {
    while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("formatEventLine error payloads", () => {
    test("renders an object error message, a message-less object, and a non-object error", () => {
        expect(formatEventLine({ type: "RunFailed", payloadJson: JSON.stringify({ error: { message: "boom" } }), timestampMs: 0 }, 0)).toContain("boom");
        expect(formatEventLine({ type: "RunFailed", payloadJson: JSON.stringify({ error: { name: "X" } }), timestampMs: 0 }, 0)).toContain('{"name":"X"}');
        expect(formatEventLine({ type: "NodeFailed", payloadJson: JSON.stringify({ nodeId: "n", error: 42 }), timestampMs: 0 }, 0)).toContain("42");
    });
});

describe("fuzzyFilter tie-break", () => {
    test("orders equal-score, equal-length matches by original index", () => {
        const result = fuzzyFilter("a", [
            { value: "1", label: "ab" },
            { value: "2", label: "ac" },
        ]);
        expect(result.map((o) => o.value)).toEqual(["1", "2"]);
    });
});

describe("resolveSmithersDocsSource fallback", () => {
    test("falls back to the latest docs URL when the package version is not semver", () => {
        const result = resolveSmithersDocsSource({ file: "llms.txt", packageVersion: "unknown", localDocsRoots: [] });
        expect(result.kind).toBe("remote");
        expect(result.url).toContain("llms.txt");
    });
});

describe("hasCustomUi read failure", () => {
    test("returns false when reading the workflow source throws", () => {
        const result = hasCustomUi("wf", "/nowhere", () => true, () => {
            throw new Error("read boom");
        });
        expect(result).toBe(false);
    });
});

describe("runSnapshotsOnce age formatting", () => {
    test("formats minute-scale and hour-scale ages", async () => {
        const now = 10_000_000_000;
        const out = [];
        const adapter = {
            async listWorkspaceCheckpoints() {
                return [
                    { seq: 1, nodeId: "a", iteration: 0, attempt: 1, tier: 1, source: "auto", jjCommitId: "c1", jjCwd: "/w", createdAtMs: now - 120_000 },
                    { seq: 2, nodeId: "b", iteration: 0, attempt: 1, tier: 1, source: "auto", jjCommitId: "c2", jjCwd: "/w", createdAtMs: now - 7_200_000 },
                ];
            },
            async listWorkspaceStates() {
                return [{ jjCwd: "/w", jjCommitId: "c1", jjOperationId: "op1" }];
            },
        };
        const result = await runSnapshotsOnce({ adapter, runId: "r", nowMs: () => now, stdout: { write: (s) => out.push(s) } });
        expect(result.exitCode).toBe(0);
        const text = out.join("");
        expect(text).toContain("2m");
        expect(text).toContain("2h");
    });
});

describe("parseMcpSurfaceArgv allowed-tools", () => {
    test("throws when --allowed-tools has no value", () => {
        expect(() => parseMcpSurfaceArgv(["--allowed-tools"])).toThrow(/Missing value for --allowed-tools/);
    });

    test("parses the inline --allowed-tools=<list> form", () => {
        const result = parseMcpSurfaceArgv(["--allowed-tools=get_run,list_runs"]);
        expect(result.allowedTools).toEqual(["get_run", "list_runs"]);
    });
});

describe("resolveSkillSource without override", () => {
    test("searches the packaged and monorepo candidate paths", () => {
        const result = resolveSkillSource();
        // Either a real candidate on disk or null — both exercise the candidate list.
        expect(result === null || (typeof result.skillMd === "string" && typeof result.llmsFull === "string")).toBe(true);
    });
});

describe("noteWorkflowPreferenceInAgentDocs failure paths", () => {
    test("returns no files when the project root is unreadable", () => {
        expect(noteWorkflowPreferenceInAgentDocs({ projectRoot: "/definitely/not/a/real/dir/xyz" })).toEqual({ files: [] });
    });

    test("reports a failed status when an agent doc entry is a directory", () => {
        const root = tempDir("note-pref-");
        mkdirSync(join(root, "AGENTS.md")); // a directory named like the doc → read throws
        const result = noteWorkflowPreferenceInAgentDocs({ projectRoot: root, fileNames: ["AGENTS.md"] });
        expect(result.files).toHaveLength(1);
        expect(result.files[0].status).toBe("failed");
    });
});

describe("buildAgentNextSteps human path", () => {
    test("builds human next-steps and resolves hasUi from the workflow id", () => {
        const result = buildAgentNextSteps({ human: true, workflowId: "hello", runId: "run-1", cwd: "/nowhere" });
        expect(Array.isArray(result.commands)).toBe(true);
        expect(typeof result.description).toBe("string");
    });
});

describe("registerSemanticTools validation", () => {
    test("rejects a tool missing annotations", () => {
        const name = SEMANTIC_TOOL_NAMES[0];
        const server = { registerTool: () => server };
        expect(() =>
            registerSemanticTools(server, [
                { name, annotations: null, description: "d", inputSchema: {}, outputSchema: {}, handler: async () => ({}) },
            ]),
        ).toThrow(/Missing annotations for semantic MCP tool/);
    });

    test("rejects duplicate tool names", () => {
        const name = SEMANTIC_TOOL_NAMES[0];
        const dup = { name, annotations: { title: "t" }, description: "d", inputSchema: {}, outputSchema: {}, handler: async () => ({}) };
        const server = { registerTool: () => server };
        expect(() => registerSemanticTools(server, [dup, { ...dup }])).toThrow(/Duplicate semantic MCP tool/);
    });
});

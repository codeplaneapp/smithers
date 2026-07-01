import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
    buildDetachedUpArgs,
    buildWorkflowPickerOptions,
    childFailurePromise,
    displayNode,
    formatStreamText,
    normalizeStreamText,
    pickerMaxItems,
    streamRun,
    truncate,
    waitForRunRow,
    wrapText,
} from "../src/tui.js";

/**
 * Strip ANSI escape codes so assertions are stable regardless of whether
 * picocolors emits color. picocolors enables color when `CI` is set even
 * without a TTY, so CI runs see styled output that local piped runs do not.
 * @param {string} value
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping
const stripAnsi = (value) => value.replace(/\x1B\[[0-9;]*m/g, "");

describe("tui helpers", () => {
    test("bounds picker height to the terminal viewport", () => {
        expect(pickerMaxItems(3)).toBe(1);
        expect(pickerMaxItems(10)).toBe(4);
        expect(pickerMaxItems(40)).toBe(12);
    });

    test("keeps workflow picker labels and hints within one terminal line", () => {
        const [option] = buildWorkflowPickerOptions([
            workflow({
                displayName: "very-long-workflow-name-that-would-wrap-in-clack",
                description: "A very long workflow description that would wrap and leave stale rows behind.",
            }),
        ], 40);

        const lineBudget = 40 - 12;
        const visible = option.label.length + (option.hint ? option.hint.length + 2 : 0);

        expect(visible).toBeLessThanOrEqual(lineBudget);
        expect(option.label).toEndWith("\u2026");
        expect(option.hint).toEndWith("\u2026");
    });

    test("lets labels use the full width budget when no hint is shown", () => {
        const [option] = buildWorkflowPickerOptions([
            workflow({
                displayName: "workflow-name-that-still-needs-truncation",
                description: "",
            }),
        ], 24);

        expect(option.label.length).toBeLessThanOrEqual(12);
        expect(option.hint).toBeUndefined();
    });

    test("shrinks option labels on extremely narrow terminals", () => {
        const [option] = buildWorkflowPickerOptions([
            workflow({
                displayName: "workflow-name-that-still-needs-truncation",
                description: "",
            }),
        ], 10);

        expect(option.label.length).toBe(1);
        expect(option.hint).toBeUndefined();
    });

    test("buildDetachedUpArgs starts with a minimal up invocation", () => {
        expect(buildDetachedUpArgs("/cli/index.js", "/wf/hello.tsx", "run-1", {})).toEqual([
            "/cli/index.js",
            "up",
            "/wf/hello.tsx",
            "--run-id",
            "run-1",
        ]);
    });

    test("buildDetachedUpArgs serializes prompted inputs as JSON", () => {
        const args = buildDetachedUpArgs("/cli/index.js", "/wf/hello.tsx", "run-1", { name: "will", n: 3 });
        const i = args.indexOf("--input");
        expect(i).toBeGreaterThan(-1);
        expect(JSON.parse(args[i + 1])).toEqual({ name: "will", n: 3 });
    });

    test("buildDetachedUpArgs threads sandbox/execution/logging options from c.options", () => {
        const args = buildDetachedUpArgs("/cli/index.js", "/wf/hello.tsx", "run-1", {}, {
            maxConcurrency: 8,
            root: "/sandbox",
            log: false,
            logDir: "/logs",
            allowNetwork: true,
            maxOutputBytes: 1024,
            toolTimeoutMs: 5000,
            hot: true,
            annotations: '{"env":"ci"}',
            backend: "pglite",
        });
        expect(args).toEqual([
            "/cli/index.js",
            "up",
            "/wf/hello.tsx",
            "--run-id",
            "run-1",
            "--max-concurrency",
            "8",
            "--root",
            "/sandbox",
            "--no-log",
            "--log-dir",
            "/logs",
            "--allow-network",
            "--max-output-bytes",
            "1024",
            "--tool-timeout-ms",
            "5000",
            "--hot",
            "--annotations",
            '{"env":"ci"}',
            "--backend",
            "pglite",
        ]);
    });

    test("buildDetachedUpArgs excludes detach/serve/interactive-only options", () => {
        const args = buildDetachedUpArgs("/cli/index.js", "/wf/hello.tsx", "run-1", {}, {
            detach: true,
            interactive: true,
            serve: true,
            supervise: true,
            port: 9999,
            host: "0.0.0.0",
            authToken: "secret",
            metrics: false,
            insecure: true,
            log: true,
        });
        expect(args).toEqual(["/cli/index.js", "up", "/wf/hello.tsx", "--run-id", "run-1"]);
        // --log default (true) must NOT emit a flag; only --no-log does.
        expect(args).not.toContain("--no-log");
    });

    test("truncate handles empty and very small budgets", () => {
        expect(truncate("", 3)).toBe("");
        expect(truncate("abc", 0)).toBe("");
        expect(truncate("abc", 1)).toBe("\u2026");
    });

    test("normalizes streamed agent output to one line", () => {
        expect(normalizeStreamText("first line\nsecond\tline\n")).toBe("first line \u21b5 second    line");
    });

    test("formats Codex tracing output as compact levelled stream text", () => {
        const home = process.env.HOME ?? "/Users/williamcory";
        const raw = [
            "2026-06-18T23:10:11.531195Z ERROR",
            `codex_core::session::session: failed to load skill ${home}/.agents/skills/smithers-snapshot-hook/SKILL.md: invalid YAML`,
        ].join("\n");

        expect(stripAnsi(formatStreamText(raw))).toBe("error failed to load skill ~/.agents/skills/smithers-snapshot-hook/SKILL.md: invalid YAML");
    });

    test("formats shell tool calls without the shell wrapper", () => {
        expect(stripAnsi(formatStreamText("[tool] /bin/zsh -lc 'git diff --stat'"))).toBe("$ git diff --stat");
        expect(stripAnsi(formatStreamText("[tool] /bin/zsh -lc 'git diff --stat' \u2192 done"))).toBe("✓ git diff --stat");
    });

    test("wraps stream output and compacts qualified node ids", () => {
        expect(displayNode("workflow:task-a")).toBe("task-a");
        expect(displayNode("task-a")).toBe("task-a");
        expect(wrapText("alpha beta gamma", 10)).toEqual(["alpha beta", "gamma"]);
        expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    });

    test("wraps colored tokens without splitting ANSI escapes", () => {
        const wrapped = wrapText("\x1B[32mabcdefgh\x1B[39m", 4);
        expect(wrapped.map(stripAnsi)).toEqual(["abcd", "efgh"]);
    });

    test("renders the final card when a run becomes terminal without a frame event", async () => {
        let getRunCalls = 0;
        const rendered = [];
        const adapter = {
            async getRun() {
                getRunCalls += 1;
                return runRow(getRunCalls === 1 ? "running" : "finished");
            },
            async listNodes() {
                return [];
            },
            async listEvents() {
                return [];
            },
        };

        const result = await streamRun(adapter, "run-terminal", "Terminal Test", "prompt", {
            intervalMs: 1,
            renderCard(card) {
                rendered.push(card.state);
            },
        });

        expect(result.state).toBe("succeeded");
        expect(rendered).toEqual(["running", "succeeded"]);
    });

    test("streamRun uses persisted node labels for streamed output", async () => {
        let getRunCalls = 0;
        let eventsReturned = false;
        const printed = [];
        const adapter = {
            async getRun() {
                getRunCalls += 1;
                return runRow(getRunCalls < 3 ? "running" : "finished");
            },
            async listNodes() {
                return [{ nodeId: "workflow:task-a", label: "Friendly Task", state: "running" }];
            },
            async listEvents() {
                if (eventsReturned) return [];
                eventsReturned = true;
                return [{
                    seq: 1,
                    timestampMs: Date.now(),
                    type: "NodeOutput",
                    payloadJson: JSON.stringify({
                        nodeId: "workflow:task-a",
                        stream: "stdout",
                        text: "hello",
                    }),
                }];
            },
        };

        const result = await streamRun(adapter, "run-label", "Label Test", "prompt", {
            intervalMs: 1,
            renderCard() {},
            printLine(_color, label, text) {
                printed.push({ label, text });
            },
        });

        expect(result.state).toBe("succeeded");
        expect(printed).toEqual([{ label: "Friendly Task", text: "hello" }]);
    });

    test("childFailurePromise resolves when the detached run exits", async () => {
        const child = new EventEmitter();
        child.exitCode = null;
        child.signalCode = null;

        const failed = childFailurePromise(child);
        child.emit("exit", 127, null);

        const error = await failed;
        expect(error.message).toContain("exit 127");
    });

    test("waitForRunRow stops immediately when the detached child exits", async () => {
        const startedAt = Date.now();
        const result = await waitForRunRow({
            async getRun() {
                return null;
            },
        }, "missing-run", 10_000, 10_000, Promise.resolve(new Error("child exited")));

        expect(result.appeared).toBe(false);
        expect(result.error?.message).toBe("child exited");
        expect(Date.now() - startedAt).toBeLessThan(500);
    });

    test("waitForRunRow accepts a fast run that appears as the child exits", async () => {
        let calls = 0;
        const result = await waitForRunRow({
            async getRun() {
                calls += 1;
                return calls === 1 ? null : runRow("finished");
            },
        }, "fast-run", 10_000, 10_000, Promise.resolve(new Error("child exited")));

        expect(result).toEqual({ appeared: true });
        expect(calls).toBe(2);
    });

    test("streamRun returns an error when the child exits before a terminal DB state", async () => {
        const startedAt = Date.now();
        const result = await streamRun(adapterForStatuses(["running", "running", "running"]), "run-terminal", "Terminal Test", "prompt", {
            intervalMs: 10_000,
            childFailure: Promise.resolve(new Error("child exited")),
            renderCard() {},
        });

        expect(result.state).toBe("running");
        expect(result.error?.message).toBe("child exited");
        expect(Date.now() - startedAt).toBeLessThan(500);
    });

    test("streamRun accepts child exit after the DB records a terminal state", async () => {
        const rendered = [];
        const result = await streamRun(adapterForStatuses(["running", "running", "finished", "finished"]), "run-terminal", "Terminal Test", "prompt", {
            intervalMs: 10_000,
            childFailure: Promise.resolve(new Error("child exited")),
            renderCard(card) {
                rendered.push(card.state);
            },
        });

        expect(result).toEqual({ state: "succeeded" });
        expect(rendered).toEqual(["running", "succeeded"]);
    });
});

function workflow(overrides = {}) {
    return {
        id: "demo",
        metadataVersion: 1,
        displayName: "Demo",
        scope: "local",
        sourceType: "user",
        description: "Demo workflow",
        tags: [],
        aliases: [],
        entryFile: "/tmp/demo.tsx",
        path: "/tmp/demo.tsx",
        ...overrides,
    };
}

function runRow(status) {
    return {
        runId: "run-terminal",
        parentRunId: null,
        workflowName: "Terminal Test",
        workflowPath: null,
        workflowHash: null,
        status,
        createdAtMs: Date.now(),
        startedAtMs: Date.now(),
        finishedAtMs: status === "finished" ? Date.now() : null,
        heartbeatAtMs: Date.now(),
        runtimeOwnerId: "test",
        cancelRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        vcsType: null,
        vcsRoot: null,
        vcsRevision: null,
        errorJson: null,
        configJson: null,
    };
}

function adapterForStatuses(statuses) {
    let index = 0;
    return {
        async getRun() {
            const status = statuses[Math.min(index, statuses.length - 1)];
            index += 1;
            return runRow(status);
        },
        async listNodes() {
            return [];
        },
        async listEvents() {
            return [];
        },
    };
}

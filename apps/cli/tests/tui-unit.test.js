import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
    buildDetachedUpArgs,
    buildTuiMonitorEnv,
    buildWorkflowPickerOptions,
    childFailurePromise,
    displayNode,
    formatStreamText,
    includeFieldValue,
    isCleanMonitorExit,
    mergeInteractiveInputs,
    normalizeStreamText,
    normalizeSuppliedInput,
    OMIT_FIELD,
    parseMonitorGatewayPort,
    pickerMaxItems,
    promptForField,
    resolveMonitorGatewayBase,
    resolveMonitorToken,
    streamRun,
    truncate,
    validateGatewayServesRun,
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

    test("isCleanMonitorExit treats interrupt teardown codes and signals as clean", () => {
        // Clean user quit / startup success.
        expect(isCleanMonitorExit(0, null)).toBe(true);
        // The TUI monitor's `128 + signo` teardown codes (SIGHUP/SIGINT/SIGTERM).
        expect(isCleanMonitorExit(129, null)).toBe(true);
        expect(isCleanMonitorExit(130, null)).toBe(true);
        expect(isCleanMonitorExit(143, null)).toBe(true);
        // Killed directly by an interrupt/terminate/hangup signal (no teardown code).
        expect(isCleanMonitorExit(null, "SIGINT")).toBe(true);
        expect(isCleanMonitorExit(null, "SIGTERM")).toBe(true);
        expect(isCleanMonitorExit(null, "SIGHUP")).toBe(true);
    });

    test("isCleanMonitorExit flags startup failures and crash signals", () => {
        // A non-zero, non-teardown exit code == the monitor failed to start.
        expect(isCleanMonitorExit(1, null)).toBe(false);
        expect(isCleanMonitorExit(2, null)).toBe(false);
        // Hard-kill / crash signals must remain failures.
        expect(isCleanMonitorExit(null, "SIGKILL")).toBe(false);
        expect(isCleanMonitorExit(null, "SIGSEGV")).toBe(false);
        expect(isCleanMonitorExit(null, "SIGABRT")).toBe(false);
    });

    test("normalizeSuppliedInput parses --input JSON and maps --prompt", () => {
        expect(normalizeSuppliedInput({ input: '{"name":"will","n":3}' })).toEqual({ name: "will", n: 3 });
        expect(normalizeSuppliedInput({ prompt: "hello" })).toEqual({ prompt: "hello" });
        // --input wins over --prompt, mirroring normalizeWorkflowRunOptions.
        expect(normalizeSuppliedInput({ input: '{"a":1}', prompt: "ignored" })).toEqual({ a: 1 });
        // No supplied input and stdin `-` normalize to {} (no supplied input).
        expect(normalizeSuppliedInput({})).toEqual({});
        expect(normalizeSuppliedInput(undefined)).toEqual({});
        expect(normalizeSuppliedInput({ input: "-" })).toEqual({});
    });

    test("normalizeSuppliedInput throws on invalid --input JSON", () => {
        expect(() => normalizeSuppliedInput({ input: "{not json" })).toThrow();
    });

    test("normalizeSuppliedInput rejects non-object top-level --input instead of dropping it", () => {
        // Arrays/scalars/null carry real user data but can't be merged into the
        // field-built input object, so they're a usage error, not silently {}.
        expect(() => normalizeSuppliedInput({ input: "[1,2,3]" })).toThrow(/must be a JSON object/);
        expect(() => normalizeSuppliedInput({ input: "42" })).toThrow(/must be a JSON object/);
        expect(() => normalizeSuppliedInput({ input: '"hi"' })).toThrow(/must be a JSON object/);
        expect(() => normalizeSuppliedInput({ input: "null" })).toThrow(/must be a JSON object/);
    });

    test("promptForField gives optional enum/boolean a skip choice and omits skipped keys", async () => {
        // Optional enum: a "(leave unset)" option is appended and, when chosen,
        // returns OMIT_FIELD so includeFieldValue drops the key.
        let enumOptions;
        const enumSkip = await promptForField(
            { name: "mode", type: "string", required: false, enum: ["fast", "slow"] },
            {
                select: async ({ options }) => {
                    enumOptions = options;
                    return options.at(-1).value; // the skip choice
                },
            },
        );
        expect(enumOptions.at(-1).value).toBe(OMIT_FIELD);
        expect(enumSkip).toBe(OMIT_FIELD);
        expect(includeFieldValue(enumSkip)).toBe(false);

        // Optional boolean with no default: rendered as a select (not a forced
        // yes/no confirm) with true/false/skip; skipping omits the key.
        let boolOptions;
        const boolSkip = await promptForField(
            { name: "verbose", type: "boolean", required: false },
            {
                select: async ({ options }) => {
                    boolOptions = options;
                    return OMIT_FIELD;
                },
            },
        );
        expect(boolOptions.map((o) => o.value)).toEqual([true, false, OMIT_FIELD]);
        expect(includeFieldValue(boolSkip)).toBe(false);

        // A required enum has NO skip option (a member must be chosen), and a
        // real chosen value is kept.
        let requiredOptions;
        const chosen = await promptForField(
            { name: "mode", type: "string", required: true, enum: ["fast", "slow"] },
            {
                select: async ({ options }) => {
                    requiredOptions = options;
                    return options[0].value;
                },
            },
        );
        expect(requiredOptions.some((o) => o.value === OMIT_FIELD)).toBe(false);
        expect(chosen).toBe("fast");
        expect(includeFieldValue(chosen)).toBe(true);

        // A chosen boolean `false` is still a real answer that must be kept.
        expect(includeFieldValue(false)).toBe(true);
        expect(includeFieldValue(undefined)).toBe(false);
    });

    test("mergeInteractiveInputs preserves supplied input when no prompts run", () => {
        expect(mergeInteractiveInputs({ a: 1, b: 2 }, {})).toEqual({ a: 1, b: 2 });
        expect(mergeInteractiveInputs({ a: 1 }, null)).toEqual({ a: 1 });
    });

    test("mergeInteractiveInputs merges prompted values over supplied, keeping uncovered keys", () => {
        // Prompted `b` overrides supplied `b`; supplied `a` (no prompt) is kept.
        expect(mergeInteractiveInputs({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
    });

    test("buildTuiMonitorEnv forwards an explicit --auth-token as SMITHERS_TOKEN", () => {
        const env = buildTuiMonitorEnv(
            { PATH: "/bin" },
            { cliIndexPath: "/cli/index.js", gatewayUrl: "http://gw:1", backend: "pglite", authToken: "secret" },
        );
        expect(env.SMITHERS_CLI).toBe("/cli/index.js");
        expect(env.SMITHERS_GATEWAY_URL).toBe("http://gw:1");
        expect(env.SMITHERS_BACKEND).toBe("pglite");
        // The TUI resolves its bearer from --token/SMITHERS_TOKEN/SMITHERS_API_KEY,
        // so an explicit CLI --auth-token must land as SMITHERS_TOKEN or it's dropped.
        expect(env.SMITHERS_TOKEN).toBe("secret");
        expect(env.PATH).toBe("/bin");
    });

    test("buildTuiMonitorEnv omits optional vars when absent", () => {
        const env = buildTuiMonitorEnv({}, { cliIndexPath: "/cli/index.js" });
        expect(env.SMITHERS_CLI).toBe("/cli/index.js");
        expect("SMITHERS_GATEWAY_URL" in env).toBe(false);
        expect("SMITHERS_BACKEND" in env).toBe(false);
        expect("SMITHERS_TOKEN" in env).toBe(false);
    });

    test("resolveMonitorGatewayBase prefers a pinned URL, else the local default", () => {
        expect(resolveMonitorGatewayBase({ SMITHERS_GATEWAY_URL: "http://host:9000/" })).toBe("http://host:9000");
        expect(resolveMonitorGatewayBase({ SMITHERS_GATEWAY_PORT: "8080" })).toBe("http://127.0.0.1:8080");
        expect(resolveMonitorGatewayBase({})).toBe("http://127.0.0.1:7331");
    });

    test("resolveMonitorGatewayBase rejects an out-of-range SMITHERS_GATEWAY_PORT", () => {
        // Without validation this built an unreachable http://127.0.0.1:70000 that
        // the health probe could never connect to. It must fail loudly instead.
        for (const bad of ["70000", "0", "-1", "8.5", "abc"]) {
            expect(() => resolveMonitorGatewayBase({ SMITHERS_GATEWAY_PORT: bad })).toThrow();
        }
        // A pinned URL bypasses the port parse entirely, so it stays valid.
        expect(resolveMonitorGatewayBase({ SMITHERS_GATEWAY_URL: "http://host:70000", SMITHERS_GATEWAY_PORT: "70000" })).toBe("http://host:70000");
    });

    test("parseMonitorGatewayPort mirrors the 1..65535 validation", () => {
        expect(parseMonitorGatewayPort(undefined)).toBe(7331);
        expect(parseMonitorGatewayPort("")).toBe(7331);
        expect(parseMonitorGatewayPort("8080")).toBe(8080);
        expect(() => parseMonitorGatewayPort("70000")).toThrow();
        expect(() => parseMonitorGatewayPort("0")).toThrow();
        expect(() => parseMonitorGatewayPort("nope")).toThrow();
    });

    test("resolveMonitorToken mirrors the TUI precedence: --auth-token, then env", () => {
        expect(resolveMonitorToken("cli-tok", { SMITHERS_TOKEN: "env-tok", SMITHERS_API_KEY: "key" })).toBe("cli-tok");
        expect(resolveMonitorToken(undefined, { SMITHERS_TOKEN: "env-tok", SMITHERS_API_KEY: "key" })).toBe("env-tok");
        expect(resolveMonitorToken(undefined, { SMITHERS_API_KEY: "key" })).toBe("key");
        expect(resolveMonitorToken(undefined, {})).toBeUndefined();
    });

    test("validateGatewayServesRun passes once the connected gateway serves the run", async () => {
        const res = await validateGatewayServesRun(
            async (id) => ({ runId: id }),
            "run-x",
            "http://127.0.0.1:7331",
        );
        expect(res).toEqual({ ok: true });
    });

    test("validateGatewayServesRun keeps polling through a transient error, then passes", async () => {
        let calls = 0;
        let clock = 0;
        const res = await validateGatewayServesRun(
            async () => {
                calls += 1;
                if (calls < 3) throw new Error("connection refused");
                return { runId: "r" };
            },
            "r",
            "http://127.0.0.1:7331",
            { timeoutMs: 10_000, intervalMs: 100, now: () => clock, sleep: async (ms) => { clock += ms; } },
        );
        expect(res).toEqual({ ok: true });
        expect(calls).toBe(3);
    });

    test("validateGatewayServesRun fails fast with a clear mismatch message", async () => {
        let clock = 0;
        // A reused gateway on a different backend/workspace: getRun never sees this
        // run, so the poll times out and surfaces an actionable error instead of a
        // silently empty monitor.
        const res = await validateGatewayServesRun(
            async () => null,
            "run-x",
            "http://127.0.0.1:7331",
            { timeoutMs: 1000, intervalMs: 250, now: () => clock, sleep: async (ms) => { clock += ms; } },
        );
        expect(res.ok).toBe(false);
        expect(res.message).toContain("does not serve run run-x");
        expect(res.message).toContain("--gateway");
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

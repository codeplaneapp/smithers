import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    armLaunchCancellation,
    buildApprovalLines,
    buildDetachedUpArgs,
    buildNextStepsLines,
    customUiExists,
    fetchCard,
    buildTuiMonitorEnv,
    buildWorkflowPickerOptions,
    childFailurePromise,
    displayNode,
    formatStreamText,
    gatewayGetRun,
    gatewayHealthy,
    includeFieldValue,
    isCleanMonitorExit,
    mergeInteractiveInputs,
    monitorStartFailure,
    monitorUnavailableFailure,
    normalizeStreamText,
    normalizeSuppliedInput,
    OMIT_FIELD,
    parseJsonFieldValue,
    parseMonitorGatewayPort,
    pickerMaxItems,
    promptForField,
    rejectIncompatibleInteractiveOptions,
    resolveInteractiveAnnotations,
    resolveMonitorGatewayBase,
    resolveMonitorToken,
    streamRun,
    superviseTuiMonitor,
    truncate,
    validateGatewayServesRun,
    waitForRunRow,
    workspaceRunExists,
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

    test("buildDetachedUpArgs never forwards a raw --annotations stdin sentinel", () => {
        // Defense-in-depth: even if the parent's resolution were bypassed, a bare
        // `-` (stdin) must never reach the stdin-`ignore`d child.
        const args = buildDetachedUpArgs("/cli/index.js", "/wf/hello.tsx", "run-1", {}, { annotations: "-" });
        expect(args).toEqual(["/cli/index.js", "up", "/wf/hello.tsx", "--run-id", "run-1"]);
    });

    test("buildDetachedUpArgs forwards --no-post-failure so the child honors the opt-out", () => {
        // The child re-parses its argv with the default (postFailure: true), so
        // dropping the flag would auto-launch the autopsy workflow the user
        // explicitly disabled.
        const disabled = buildDetachedUpArgs("/cli/index.js", "/wf/hello.tsx", "run-1", {}, { postFailure: false });
        expect(disabled).toContain("--no-post-failure");
        // Default-on (true after parsing) and unset both emit nothing; only the
        // opt-out needs forwarding.
        expect(buildDetachedUpArgs("/cli/index.js", "/wf/hello.tsx", "run-1", {}, { postFailure: true })).not.toContain("--no-post-failure");
        expect(buildDetachedUpArgs("/cli/index.js", "/wf/hello.tsx", "run-1", {}, {})).not.toContain("--no-post-failure");
        // It is a FORWARD option in the interactive disposition audit, never a reject.
        expect(rejectIncompatibleInteractiveOptions({ postFailure: false })).toBeNull();
        expect(rejectIncompatibleInteractiveOptions({ postFailure: true })).toBeNull();
    });

    test("rejectIncompatibleInteractiveOptions passes clean/forwarded/resolved options", () => {
        // All-defaults (nothing explicitly set) and the FORWARD/RESOLVE options are
        // fine — only genuinely incompatible flags are rejected.
        expect(rejectIncompatibleInteractiveOptions(undefined)).toBeNull();
        expect(rejectIncompatibleInteractiveOptions({})).toBeNull();
        expect(
            rejectIncompatibleInteractiveOptions({
                detach: false,
                resume: false,
                force: false,
                serve: false,
                supervise: false,
                superviseDryRun: false,
                superviseInterval: "10s",
                superviseStaleThreshold: "30s",
                superviseMaxConcurrent: 3,
                host: "127.0.0.1",
                port: 7331,
                metrics: true,
                insecure: false,
                // Forwarded / resolved options must not trip the audit.
                runId: "run-1",
                root: "/sandbox",
                backend: "pglite",
                maxConcurrency: 8,
                log: false,
                logDir: "/logs",
                allowNetwork: true,
                maxOutputBytes: 1024,
                toolTimeoutMs: 5000,
                hot: true,
                input: '{"a":1}',
                annotations: '{"env":"ci"}',
                authToken: "secret",
            }),
        ).toBeNull();
    });

    test("rejectIncompatibleInteractiveOptions rejects --resume and --force", () => {
        // Interactive mode always starts a NEW run, so resume/force are rejected
        // rather than silently dropped (which would surprise the user with a fresh run).
        const resumeBool = rejectIncompatibleInteractiveOptions({ resume: true });
        expect(resumeBool?.code).toBe("TUI_INCOMPATIBLE_OPTION");
        expect(resumeBool?.exitCode).toBe(4);
        expect(resumeBool?.message).toContain("--resume");
        expect(rejectIncompatibleInteractiveOptions({ resume: "run-42" })?.message).toContain("--resume");
        expect(rejectIncompatibleInteractiveOptions({ force: true })?.message).toContain("--force");
    });

    test("rejectIncompatibleInteractiveOptions rejects --detach and the HTTP-server family", () => {
        expect(rejectIncompatibleInteractiveOptions({ detach: true })?.message).toContain("--detach");
        expect(rejectIncompatibleInteractiveOptions({ serve: true })?.message).toContain("--serve");
        expect(rejectIncompatibleInteractiveOptions({ supervise: true })?.message).toContain("--supervise");
        expect(rejectIncompatibleInteractiveOptions({ superviseDryRun: true })?.message).toContain("--supervise-dry-run");
        expect(rejectIncompatibleInteractiveOptions({ superviseInterval: "5s" })?.message).toContain("--supervise-interval");
        expect(rejectIncompatibleInteractiveOptions({ superviseStaleThreshold: "1m" })?.message).toContain("--supervise-stale-threshold");
        expect(rejectIncompatibleInteractiveOptions({ superviseMaxConcurrent: 5 })?.message).toContain("--supervise-max-concurrent");
        expect(rejectIncompatibleInteractiveOptions({ host: "0.0.0.0" })?.message).toContain("--host");
        expect(rejectIncompatibleInteractiveOptions({ port: 8080 })?.message).toContain("--port");
        expect(rejectIncompatibleInteractiveOptions({ metrics: false })?.message).toContain("--no-metrics");
        expect(rejectIncompatibleInteractiveOptions({ insecure: true })?.message).toContain("--insecure");
    });

    test("rejectIncompatibleInteractiveOptions rejects the internal resume-claim flags", () => {
        expect(rejectIncompatibleInteractiveOptions({ resumeClaimOwner: "o" })?.message).toContain("--resume-claim-owner");
        expect(rejectIncompatibleInteractiveOptions({ resumeClaimHeartbeat: 5 })?.message).toContain("--resume-claim-heartbeat");
        expect(rejectIncompatibleInteractiveOptions({ resumeRestoreOwner: "o" })?.message).toContain("--resume-restore-owner");
        expect(rejectIncompatibleInteractiveOptions({ resumeRestoreHeartbeat: 5 })?.message).toContain("--resume-restore-heartbeat");
    });

    test("resolveInteractiveAnnotations validates and returns the JSON string", () => {
        expect(resolveInteractiveAnnotations({})).toBeUndefined();
        expect(resolveInteractiveAnnotations({ annotations: '{"env":"ci","n":3,"ok":true}' })).toBe('{"env":"ci","n":3,"ok":true}');
    });

    test("resolveInteractiveAnnotations rejects the stdin `-` sentinel", () => {
        // Prompts own the terminal, and the detached child's stdin is ignored, so
        // `-` cannot be honored — reject instead of forwarding a raw `-`.
        expect(() => resolveInteractiveAnnotations({ annotations: "-" })).toThrow(/stdin/);
    });

    test("resolveInteractiveAnnotations rejects invalid/non-flat annotations", () => {
        expect(() => resolveInteractiveAnnotations({ annotations: "{not json" })).toThrow();
        expect(() => resolveInteractiveAnnotations({ annotations: "[1,2,3]" })).toThrow(/flat JSON object/);
        expect(() => resolveInteractiveAnnotations({ annotations: '{"a":{"nested":1}}' })).toThrow(/must be a string, number, or boolean/);
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

    test("buildApprovalLines carries the exact approve command", () => {
        expect(buildApprovalLines("run-1", [])).toEqual([]);
        expect(buildApprovalLines("run-1", null)).toEqual([]);

        // One pending gate: approve auto-detects the node, so no --node.
        const [single] = buildApprovalLines("run-1", [{ nodeId: "wf:gate" }]).map(stripAnsi);
        expect(single).toBe("approval needed (gate) · smithers approve run-1");

        // Several pending gates: each line pins its node via --node.
        const many = buildApprovalLines("run-1", [{ nodeId: "a" }, { nodeId: "b" }]).map(stripAnsi);
        expect(many).toEqual([
            "approval needed (a) · smithers approve run-1 --node a",
            "approval needed (b) · smithers approve run-1 --node b",
        ]);
    });

    test("buildNextStepsLines suggests ui, graph, tree, and create-workflow", () => {
        const lines = buildNextStepsLines({
            runId: "run-1",
            workflowId: "hello",
            entryFile: "/wf/hello.tsx",
            uiExists: false,
        });
        // Without a custom UI, `smithers ui run-1` fails NO_UI (there is no
        // generic run inspector behind it), so the guidance must lead with
        // AUTHORING the UI file — mirroring buildAgentNextSteps' wording.
        expect(lines[0]).toContain(".smithers/ui/hello.tsx");
        expect(lines[0]).toContain("gateway-react");
        expect(lines[0]).toContain("smithers ui run-1");
        expect(lines).toContainEqual(expect.stringContaining("smithers graph /wf/hello.tsx"));
        expect(lines).toContainEqual(expect.stringContaining("smithers tree run-1"));
        expect(lines).toContainEqual(expect.stringContaining("smithers workflow run create-workflow"));

        // With a custom UI present the ui line stops suggesting authoring one.
        const withUi = buildNextStepsLines({ runId: "run-1", workflowId: "hello", uiExists: true });
        expect(withUi[0]).toContain("custom UI");
        expect(withUi[0]).not.toContain(".smithers/ui/hello.tsx");
        // No entryFile: the graph suggestion is omitted rather than malformed.
        expect(withUi.some((l) => l.includes("smithers graph"))).toBe(false);

        // No workflow id and no UI: we can't name a UI file to author and
        // `smithers ui run-1` would fail NO_UI, so point at the full
        // control-plane UI instead.
        const anonymous = buildNextStepsLines({ runId: "run-1", uiExists: false });
        expect(anonymous[0]).toContain("smithers ui --app");
        expect(anonymous[0]).not.toContain("smithers ui run-1");

        for (const line of [...lines, ...withUi, ...anonymous]) {
            // The false "open this run in the inspector" claim must never come
            // back: the command has no inspector fallback.
            expect(line).not.toContain("inspector");
            // No em-dashes anywhere in operator-facing guidance.
            expect(line).not.toContain("—");
        }
    });

    test("customUiExists resolves the .smithers/ui/<workflowId>.tsx convention", () => {
        const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-ui-"));
        mkdirSync(join(cwd, ".smithers", "ui"), { recursive: true });
        writeFileSync(join(cwd, ".smithers", "ui", "hello.tsx"), "export default null;\n");
        expect(customUiExists("hello", cwd)).toBe(true);
        expect(customUiExists("missing", cwd)).toBe(false);
        expect(customUiExists(undefined, cwd)).toBe(false);
    });

    test("fetchCard surfaces pending approvals and the custom-UI footer", async () => {
        const adapter = {
            async getRun() {
                return runRow("running");
            },
            async listNodes() {
                return [];
            },
            async listPendingApprovals() {
                return [{ nodeId: "wf:gate" }];
            },
        };
        const card = await fetchCard(adapter, "run-terminal", "Name", "prompt", { uiExists: true });
        expect(card.approvalLines.map(stripAnsi)).toEqual(["approval needed (gate) · smithers approve run-terminal"]);
        expect(card.footer).toContain("smithers ui run-terminal");
    });

    test("fetchCard tolerates adapters without listPendingApprovals", async () => {
        const card = await fetchCard(adapterForStatuses(["running"]), "run-terminal", "Name", "prompt");
        expect(card.approvalLines).toEqual([]);
        expect(card.footer).not.toContain("smithers ui");
    });

    test("streamRun collapses consecutive FrameCommitted events into one card render", async () => {
        let renders = 0;
        let eventsDrained = false;
        const adapter = {
            async getRun() {
                return runRow(eventsDrained ? "finished" : "running");
            },
            async listNodes() {
                return [];
            },
            async listEvents() {
                if (eventsDrained) return [];
                eventsDrained = true;
                return [1, 2, 3].map((seq) => ({ seq, type: "FrameCommitted", payloadJson: "{}" }));
            },
        };

        const result = await streamRun(adapter, "run-frames", "Frames", "prompt", {
            intervalMs: 1,
            renderCard() {
                renders += 1;
            },
        });

        expect(result.state).toBe("succeeded");
        // Initial card + ONE render for the whole 3-frame batch (which already
        // shows the terminal state, so no extra final render) — not one per frame.
        expect(renders).toBe(2);
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

    test("waitForRunRow never accepts a run row older than the child spawn time", async () => {
        // A user-supplied --run-id colliding with an OLD run: the child dies
        // RUN_EXISTS (its stderr only in the log file) while the stale row sits in
        // the store. Without the spawn-time guard the wait would report the OLD
        // run as "started" and the launcher would monitor it.
        const stale = { ...runRow("finished"), createdAtMs: 1_000 };
        const result = await waitForRunRow({
            async getRun() {
                return stale;
            },
        }, "run-old", 10_000, 10_000, Promise.resolve(new Error("Run process exited (exit 4).")), 2_000);

        expect(result.appeared).toBe(false);
        expect(result.error?.message).toContain("exit 4");
    });

    test("waitForRunRow accepts fresh rows, and rows without a createdAtMs stamp", async () => {
        // Created at/after the spawn time: the child's own row.
        const fresh = await waitForRunRow({
            async getRun() {
                return { ...runRow("running"), createdAtMs: 2_000 };
            },
        }, "run-new", 10_000, 10, undefined, 2_000);
        expect(fresh).toEqual({ appeared: true });

        // Only a DEFINITELY stale timestamp is rejected: a row without a numeric
        // createdAtMs keeps the pre-guard behavior instead of stalling launches.
        const unstamped = await waitForRunRow({
            async getRun() {
                return { ...runRow("running"), createdAtMs: undefined };
            },
        }, "run-unstamped", 10_000, 10, undefined, 2_000);
        expect(unstamped).toEqual({ appeared: true });
    });

    test("workspaceRunExists reports a collision only on a positive match, and always cleans up", async () => {
        let cleanups = 0;
        const storeWith = (row) => async () => ({
            adapter: {
                async getRun() {
                    return row;
                },
            },
            cleanup() {
                cleanups += 1;
            },
        });
        expect(await workspaceRunExists("run-1", { openStore: storeWith(runRow("finished")) })).toBe(true);
        expect(await workspaceRunExists("run-1", { openStore: storeWith(null) })).toBe(false);
        expect(cleanups).toBe(2);
    });

    test("workspaceRunExists treats a missing store and probe failures as no collision", async () => {
        // Fresh workspace: no store yet, so no run can collide.
        const notFound = async () => {
            const err = new Error("no smithers db");
            err.code = "CLI_DB_NOT_FOUND";
            throw err;
        };
        expect(await workspaceRunExists("run-1", { openStore: notFound })).toBe(false);

        // Any other probe failure defers to the spawn path's own error handling
        // (the child would hit the same fault and surface it loudly there).
        const migration = async () => {
            throw new Error("SMITHERS_MIGRATION_REQUIRED");
        };
        expect(await workspaceRunExists("run-1", { openStore: migration })).toBe(false);

        let cleaned = false;
        const readFails = async () => ({
            adapter: {
                async getRun() {
                    throw new Error("database is locked");
                },
            },
            cleanup() {
                cleaned = true;
            },
        });
        expect(await workspaceRunExists("run-1", { openStore: readFails })).toBe(false);
        expect(cleaned).toBe(true);
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

    test("promptForField parses object/array answers into REAL values, re-asking on bad JSON", async () => {
        // The collected inputs are JSON.stringify'd into the child's --input and
        // nothing downstream rejects a string on a json column, so the prompt is
        // the ONLY place a raw '["a","b"]' string can be caught and parsed.
        const rejections = [];
        // A clack-like text prompt: walks the queued answers through `validate`
        // the way clack re-asks on a validation error, resolving with the first
        // accepted answer.
        const textAnswering = (answers) => async ({ validate }) => {
            for (const answer of answers) {
                const error = validate?.(answer);
                if (!error) return answer;
                rejections.push(error);
            }
            throw new Error("every queued answer was rejected");
        };

        const items = await promptForField(
            { name: "items", type: "array", required: true },
            { text: textAnswering(["not json", '{"k":1}', '["a","b"]']) },
        );
        expect(items).toEqual(["a", "b"]);
        expect(rejections[0]).toContain("valid JSON");
        expect(rejections[1]).toContain("JSON array");

        const features = await promptForField(
            { name: "features", type: "object", required: true },
            { text: textAnswering(['["not","an","object"]', '{"web":["auth"]}']) },
        );
        expect(features).toEqual({ web: ["auth"] });
        expect(rejections[2]).toContain("JSON object");
    });

    test("promptForField keeps blank/default handling for JSON fields", async () => {
        // Blank optional: absence stays absence (no default), so the key is omitted.
        const blank = await promptForField(
            { name: "extras", type: "array", required: false },
            {
                text: async ({ validate }) => {
                    expect(validate("")).toBeUndefined();
                    return "";
                },
            },
        );
        expect(blank).toBeUndefined();
        expect(includeFieldValue(blank)).toBe(false);

        // A JSON default renders as its JSON spelling (not "[object Object]") and
        // a blank answer returns the REAL default value, never a string.
        let placeholder;
        const defaulted = await promptForField(
            { name: "cfg", type: "object", required: false, default: { a: 1 } },
            {
                text: async (opts) => {
                    placeholder = opts.placeholder;
                    return "";
                },
            },
        );
        expect(placeholder).toBe('{"a":1}');
        expect(defaulted).toEqual({ a: 1 });
    });

    test("promptForField seeds a CLI-supplied value so a bare Enter keeps it over the schema default", async () => {
        // Simulate clack returning the pre-filled initialValue on a bare Enter.
        const enterKeepsInitial = async ({ initialValue }) => initialValue ?? "";

        // The bug: create-workflow's `prompt` field declares a z.default, which
        // used to clobber a task the user already typed. The supplied value must win.
        const kept = await promptForField(
            { name: "prompt", type: "string", required: false, default: "SCHEMA DEFAULT" },
            { text: enterKeepsInitial },
            "build a docs-sync workflow",
        );
        expect(kept).toBe("build a docs-sync workflow");

        // A JSON-typed supplied value is seeded as its JSON spelling and parsed back.
        let seededJsonInitial;
        const cfg = await promptForField(
            { name: "cfg", type: "object", required: false, default: { a: 1 } },
            {
                text: async ({ initialValue }) => {
                    seededJsonInitial = initialValue;
                    return initialValue ?? "";
                },
            },
            { web: ["auth"] },
        );
        expect(seededJsonInitial).toBe('{"web":["auth"]}');
        expect(cfg).toEqual({ web: ["auth"] });

        // Enum/select fields seed initialValue too.
        let seededSelectInitial;
        const mode = await promptForField(
            { name: "mode", type: "string", required: true, enum: ["fast", "slow"] },
            {
                select: async ({ initialValue }) => {
                    seededSelectInitial = initialValue;
                    return initialValue ?? "fast";
                },
            },
            "slow",
        );
        expect(seededSelectInitial).toBe("slow");
        expect(mode).toBe("slow");

        // With NO supplied value, behavior is unchanged: a bare Enter yields the default.
        const def = await promptForField(
            { name: "prompt", type: "string", required: false, default: "SCHEMA DEFAULT" },
            { text: async ({ initialValue }) => initialValue ?? "" },
        );
        expect(def).toBe("SCHEMA DEFAULT");
    });

    test("parseJsonFieldValue shape-checks pure declarations and spares string unions", () => {
        expect(parseJsonFieldValue("items", ["array"], '["a"]')).toEqual({ value: ["a"] });
        expect(parseJsonFieldValue("cfg", ["object"], '{"a":1}')).toEqual({ value: { a: 1 } });
        expect("error" in parseJsonFieldValue("items", ["array"], '{"a":1}')).toBe(true);
        expect("error" in parseJsonFieldValue("cfg", ["object"], "[1]")).toBe(true);
        expect("error" in parseJsonFieldValue("cfg", ["object"], "null")).toBe(true);
        // A union that also admits a plain string keeps non-JSON text as-is.
        expect(parseJsonFieldValue("q", ["string", "array"], "hello")).toEqual({ value: "hello" });
        expect(parseJsonFieldValue("q", ["string", "array"], '["a"]')).toEqual({ value: ["a"] });
        // Mixed object/array unions accept either shape.
        expect(parseJsonFieldValue("any", ["object", "array"], "[1]")).toEqual({ value: [1] });
        expect(parseJsonFieldValue("any", ["object", "array"], '{"a":1}')).toEqual({ value: { a: 1 } });
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

    test("validateGatewayServesRun fails FAST (no wait) on a non-retryable error", async () => {
        let clock = 0;
        let calls = 0;
        // An auth rejection (retryable === false) must surface immediately with its
        // own message, not stall until the timeout and then blame a backend mismatch.
        const res = await validateGatewayServesRun(
            async () => {
                calls += 1;
                const err = new Error("gateway rejected auth (401) — check --token/SMITHERS_TOKEN/SMITHERS_API_KEY.");
                err.retryable = false;
                throw err;
            },
            "run-x",
            "http://127.0.0.1:7331",
            { timeoutMs: 10_000, intervalMs: 250, now: () => clock, sleep: async (ms) => { clock += ms; } },
        );
        expect(res.ok).toBe(false);
        expect(res.message).toContain("rejected auth (401)");
        expect(res.message).not.toContain("does not serve run");
        // Exactly one probe: it did not poll again or wait out the budget.
        expect(calls).toBe(1);
        expect(clock).toBe(0);
    });

    test("gatewayGetRun classifies a 401 as a non-retryable auth failure", async () => {
        const fetchImpl = async () => new Response(JSON.stringify({ type: "res", ok: false, error: { code: "Unauthorized", message: "no" } }), { status: 401 });
        let thrown;
        try {
            await gatewayGetRun("http://127.0.0.1:7331", "run-x", "bad-token", { fetchImpl });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.retryable).toBe(false);
        expect(thrown.message).toContain("rejected auth (401)");
    });

    test("gatewayGetRun classifies a malformed (non-frame) body as non-retryable", async () => {
        const fetchImpl = async () => new Response("<html>not a frame</html>", { status: 200 });
        let thrown;
        try {
            await gatewayGetRun("http://127.0.0.1:7331", "run-x", undefined, { fetchImpl });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.retryable).toBe(false);
        expect(thrown.message).toContain("invalid response");
    });

    test("gatewayGetRun treats RunNotFound as a not-there-yet miss (null, keep polling)", async () => {
        const fetchImpl = async () => new Response(JSON.stringify({ type: "res", ok: false, error: { code: "RunNotFound", message: "no" } }), { status: 404 });
        const res = await gatewayGetRun("http://127.0.0.1:7331", "run-x", undefined, { fetchImpl });
        expect(res).toBeNull();
    });

    test("gatewayGetRun rejects (retryable) quickly when the gateway never responds", async () => {
        // A process bound to the port but never answering: the per-request timeout
        // must abort the fetch and surface a RETRYABLE miss quickly, not hang.
        const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        });
        const startedAt = Date.now();
        let thrown;
        try {
            await gatewayGetRun("http://127.0.0.1:7331", "run-x", undefined, { fetchImpl, timeoutMs: 20 });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.retryable).toBe(true);
        // Resolved via the abort, not by hanging: comfortably under a real socket wait.
        expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    test("gatewayHealthy returns false (not hang) when the gateway never responds", async () => {
        const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        });
        const startedAt = Date.now();
        const healthy = await gatewayHealthy("http://127.0.0.1:7331", undefined, { fetchImpl, timeoutMs: 20 });
        expect(healthy).toBe(false);
        expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    test("superviseTuiMonitor returns the monitor exit on a clean user quit", async () => {
        // The user quit the monitor while the detached run kept running (its
        // failure promise never settles); the monitor exit is passed through and
        // the monitor is not force-terminated.
        const monitor = fakeMonitor(Promise.resolve({ code: 0, signal: null }));
        const result = await superviseTuiMonitor(
            monitor,
            new Promise(() => {}),
            adapterForStatuses(["running"]),
            "run-terminal",
        );
        expect(result).toEqual({ exit: { code: 0, signal: null } });
        expect(monitor.terminated).toBe(false);
    });

    test("superviseTuiMonitor fails when the detached child dies with the run still in flight", async () => {
        // Monitor stays up; the detached run process dies while the run is still
        // "running" — a premature death. The monitor is terminated and the error
        // is returned so the caller reports TUI_RUN_EXITED instead of success.
        const monitor = fakeMonitor(new Promise(() => {}));
        const result = await superviseTuiMonitor(
            monitor,
            Promise.resolve(new Error("Run process exited (exit 1).")),
            adapterForStatuses(["running"]),
            "run-terminal",
        );
        expect(result.error?.message).toContain("exit 1");
        expect(monitor.terminated).toBe(true);
    });

    test("superviseTuiMonitor folds a monitor spawn failure into a recoverable monitorError", async () => {
        // The monitor's exit promise REJECTS (spawn/startup failure) while the
        // detached run keeps running. The race must not throw an unhandled
        // rejection: it returns { monitorError } so the caller can fall back to
        // streamRun and keep the run observable.
        const monitor = fakeMonitor(Promise.reject(new Error("spawn bun ENOENT")));
        const result = await superviseTuiMonitor(
            monitor,
            new Promise(() => {}),
            adapterForStatuses(["running"]),
            "run-terminal",
        );
        expect(result.monitorError?.message).toContain("ENOENT");
        expect(result.exit).toBeUndefined();
        expect(result.error).toBeUndefined();
        // The run is still alive, so the monitor is not force-terminated here.
        expect(monitor.terminated).toBe(false);
    });

    test("superviseTuiMonitor keeps the monitor up when the child exits after a terminal run state", async () => {
        // The detached child exits first (its failure promise wins the race), but
        // the run already recorded a terminal state — a legitimate end. The monitor
        // is left up until the user quits, and its exit is returned unchanged.
        const monitor = fakeMonitor(new Promise((resolve) => setTimeout(() => resolve({ code: 0, signal: null }), 5)));
        const result = await superviseTuiMonitor(
            monitor,
            Promise.resolve(new Error("Run process exited (exit 0).")),
            adapterForStatuses(["finished"]),
            "run-terminal",
        );
        expect(result).toEqual({ exit: { code: 0, signal: null } });
        expect(monitor.terminated).toBe(false);
    });

    test("superviseTuiMonitor accepts thenable DB reads without Promise catch", async () => {
        // SmithersDb read methods are awaitable Effects. They implement `then`,
        // but they are not native Promises and do not provide `.catch()`.
        const monitor = fakeMonitor(new Promise((resolve) => setTimeout(() => resolve({ code: 0, signal: null }), 5)));
        const adapter = {
            getRun() {
                return {
                    then(resolve) {
                        resolve(runRow("finished"));
                    },
                };
            },
        };
        const result = await superviseTuiMonitor(
            monitor,
            Promise.resolve(new Error("Run process exited (exit 0).")),
            adapter,
            "run-terminal",
        );
        expect(result).toEqual({ exit: { code: 0, signal: null } });
        expect(monitor.terminated).toBe(false);
    });

    test("monitor-failure guidance says the run is STILL RUNNING and never suggests smithers-mon", () => {
        // Both descriptors fire AFTER the run launched; the launcher leaves the
        // durable run alive, so the message must say so and point at surfaces
        // that always work. `smithers-mon` is the bin of @smithers-orchestrator/tui
        // — in the unresolvable case, the very package that failed to resolve.
        for (const failure of [
            monitorStartFailure(new Error("spawn bun ENOENT"), "run-1", "/logs/run-1.log"),
            monitorUnavailableFailure("run-1", "/logs/run-1.log"),
        ]) {
            expect(failure.exitCode).toBe(1);
            expect(failure.runId).toBe("run-1");
            expect(failure.logFile).toBe("/logs/run-1.log");
            expect(failure.message).toContain("still running");
            expect(failure.message).toContain("smithers ps");
            expect(failure.message).toContain("smithers inspect run-1");
            expect(failure.message).toContain("/logs/run-1.log");
            expect(failure.message).not.toContain("smithers-mon");
        }
        expect(monitorStartFailure(new Error("spawn bun ENOENT"), "run-1", "/l.log").code).toBe("TUI_MONITOR_FAILED");
        expect(monitorStartFailure(new Error("spawn bun ENOENT"), "run-1", "/l.log").message).toContain("spawn bun ENOENT");
        expect(monitorUnavailableFailure("run-1", "/l.log").code).toBe("TUI_MONITOR_UNAVAILABLE");
        expect(monitorUnavailableFailure("run-1", "/l.log").message).toContain("@smithers-orchestrator/tui");
    });

    test("armLaunchCancellation tears the unannounced run down when clack exits the process", () => {
        // Keyboard Ctrl-C during the "Starting…" spinner: clack holds stdin RAW,
        // sees \x03 as a cancel keypress, and calls process.exit(0) — no signal is
        // ever delivered. The "exit" hook is the only interception point, and it
        // must terminate the child AND say what was stopped (the run id and log
        // path were never printed at this stage).
        const proc = new EventEmitter();
        const written = [];
        const exits = [];
        let terminated = 0;
        armLaunchCancellation({
            runId: "run-1",
            logFile: "/logs/run-1.log",
            terminate: () => {
                terminated += 1;
            },
            write: (line) => written.push(line),
            exit: (code) => exits.push(code),
            proc,
        });

        proc.emit("exit");
        expect(terminated).toBe(1);
        expect(written).toHaveLength(1);
        expect(written[0]).toContain("run-1");
        expect(written[0]).toContain("stopped");
        expect(written[0]).toContain("/logs/run-1.log");
        // The process is already exiting; the hook must not call exit() itself.
        expect(exits).toEqual([]);

        // Idempotent: the first stop disarms, so a racing signal or second exit
        // can neither double-kill nor double-print.
        proc.emit("exit");
        proc.emit("SIGINT");
        expect(terminated).toBe(1);
        expect(written).toHaveLength(1);
    });

    test("armLaunchCancellation terminates and exits 130/143 on external signals", () => {
        // External `kill -INT`/`-TERM` while the spinner runs: clack's handler
        // prints "Canceled" and CONTINUES, so ours must stop the child, report,
        // and exit with the conventional interrupt code.
        for (const [signal, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
            const proc = new EventEmitter();
            const written = [];
            const exits = [];
            let terminated = 0;
            armLaunchCancellation({
                runId: "run-1",
                logFile: "/logs/run-1.log",
                terminate: () => {
                    terminated += 1;
                },
                write: (line) => written.push(line),
                exit: (code) => exits.push(code),
                proc,
            });
            proc.emit(signal);
            expect(terminated).toBe(1);
            expect(exits).toEqual([expectedCode]);
            expect(written).toHaveLength(1);
            // The exit(130/143) path fires the real process "exit" event next;
            // the already-disarmed hook must stay quiet.
            proc.emit("exit");
            expect(terminated).toBe(1);
            expect(written).toHaveLength(1);
        }
    });

    test("armLaunchCancellation disarm removes every hook so a later cancel keeps the run alive", () => {
        // Once the run is announced (spinner stop printed the id + log path), a
        // user cancel or monitor quit must leave the durable run running: disarm
        // removes all hooks, so nothing fires afterwards.
        const proc = new EventEmitter();
        const written = [];
        const exits = [];
        let terminated = 0;
        const cancellation = armLaunchCancellation({
            runId: "run-1",
            logFile: "/logs/run-1.log",
            terminate: () => {
                terminated += 1;
            },
            write: (line) => written.push(line),
            exit: (code) => exits.push(code),
            proc,
        });
        cancellation.disarm();
        expect(proc.listenerCount("exit")).toBe(0);
        expect(proc.listenerCount("SIGINT")).toBe(0);
        expect(proc.listenerCount("SIGTERM")).toBe(0);
        proc.emit("exit");
        proc.emit("SIGINT");
        proc.emit("SIGTERM");
        expect(terminated).toBe(0);
        expect(written).toHaveLength(0);
        expect(exits).toEqual([]);
    });
});

/**
 * A stand-in for the object launchTuiMonitor returns: an `exit` promise plus a
 * `terminate` that records whether it was called, so supervision tests can assert
 * the monitor is (or is not) force-stopped without spawning a real child.
 * @param {Promise<{ code: number | null; signal: NodeJS.Signals | null }>} exit
 */
function fakeMonitor(exit) {
    let terminated = false;
    return {
        exit,
        terminate() {
            terminated = true;
        },
        get terminated() {
            return terminated;
        },
    };
}

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

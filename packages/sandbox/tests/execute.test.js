import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { withTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { __executeSandboxInternals, executeSandbox, registerSandboxProvider } from "../src/execute.js";

/**
 * @param {string} prefix
 */
function tempDir(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
}

function createDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), db, sqlite };
}

/**
 * @param {unknown} db
 * @param {{ runId?: string; heartbeats?: Array<unknown> }} [options]
 */
function createRuntime(db, options = {}) {
    const heartbeats = options.heartbeats ?? [];
    return {
        runId: options.runId ?? "parent-run",
        stepId: "sandbox-step",
        attempt: 1,
        iteration: 0,
        signal: new AbortController().signal,
        db,
        heartbeat: (data) => heartbeats.push(data),
        lastHeartbeat: null,
    };
}

/**
 * @param {unknown} runtime
 * @param {Partial<import("../src/ExecuteSandboxOptions.ts").ExecuteSandboxOptions>} overrides
 */
async function runInRuntime(runtime, overrides = {}) {
    return withTaskRuntime(runtime, () =>
        executeSandbox({
            sandboxId: "sandbox-1",
            runtime: "codeplane",
            parentWorkflow: { build: () => null },
            workflow: { build: () => null },
            executeChildWorkflow: async () => ({
                runId: "child-run",
                status: "finished",
                output: { ok: true },
            }),
            input: { prompt: "ship it" },
            rootDir: tempDir("smithers-sandbox-execute-"),
            allowNetwork: false,
            maxOutputBytes: 1024,
            toolTimeoutMs: 250,
            reviewDiffs: false,
            ...overrides,
        }),
    );
}

/**
 * @template T
 * @param {() => Promise<T>} execute
 * @returns {Promise<T>}
 */
async function withCodeplaneEnv(execute) {
    const previousUrl = process.env.CODEPLANE_API_URL;
    const previousKey = process.env.CODEPLANE_API_KEY;
    process.env.CODEPLANE_API_URL = "http://codeplane.test";
    process.env.CODEPLANE_API_KEY = "test-key";
    try {
        return await execute();
    }
    finally {
        if (previousUrl === undefined) {
            delete process.env.CODEPLANE_API_URL;
        }
        else {
            process.env.CODEPLANE_API_URL = previousUrl;
        }
        if (previousKey === undefined) {
            delete process.env.CODEPLANE_API_KEY;
        }
        else {
            process.env.CODEPLANE_API_KEY = previousKey;
        }
    }
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function eventTypes(adapter, runId) {
    const rows = await adapter.listEvents(runId, -1);
    return rows.map((row) => row.type);
}

/**
 * @param {string} rootDir
 * @param {string} parentRunId
 * @param {string} sandboxId
 */
function resultPath(rootDir, parentRunId, sandboxId) {
    return join(rootDir, ".smithers", "sandboxes", parentRunId, sandboxId, "result");
}

/**
 * @param {string} rootDir
 * @param {string} childRunId
 * @param {string} content
 */
function writeChildLog(rootDir, childRunId, content = "{\"event\":\"child\"}\n") {
    const logDir = join(rootDir, ".smithers", "executions", childRunId, "logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "stream.ndjson"), content, "utf8");
}

function onePatchDiffBundle() {
    return {
        seq: 1,
        baseRef: "HEAD",
        patches: [
            {
                path: "src/app.ts",
                operation: "modify",
                diff: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
            },
        ],
    };
}

describe("executeSandbox", () => {
    test("covers defensive helper branches used by sandbox execution", async () => {
        const root = tempDir("smithers-sandbox-execute-helper-");
        mkdirSync(join(root, "README.md"), { recursive: true });
        expect(await __executeSandboxInternals.directorySize(join(root, "README.md"))).toBe(0);
        expect(await __executeSandboxInternals.directorySize(join(root, "missing"))).toBe(0);
        expect(() => __executeSandboxInternals.requireSandboxHandle(null, "missing-handle")).toThrow(
            "did not initialize correctly",
        );
        const handle = { sandboxId: "ok" };
        expect(__executeSandboxInternals.requireSandboxHandle(handle, "ok")).toBe(handle);
        expect(__executeSandboxInternals.resolveSandboxCommand("custom run")).toBe("custom run");
        expect(__executeSandboxInternals.resolveSandboxCommand("   ")).toBe("smithers up bundle.tsx");
        expect(__executeSandboxInternals.resolveSandboxCommand(undefined)).toBe("smithers up bundle.tsx");
        expect(__executeSandboxInternals.redactSandboxConfig({
            image: "example/sandbox",
            env: { SECRET_TOKEN: "secret", PUBLIC_MODE: "test" },
        })).toEqual({
            image: "example/sandbox",
            env: { PUBLIC_MODE: "[redacted]", SECRET_TOKEN: "[redacted]" },
        });
    });

    test("runs a child workflow, collects the bundle, and persists sandbox events", async () => {
        const { adapter, db, sqlite } = createDb();
        const rootDir = tempDir("smithers-sandbox-execute-");
        const heartbeats = [];
        const runtime = createRuntime(db, { heartbeats });
        const childCalls = [];
        try {
            const output = await withCodeplaneEnv(() =>
                runInRuntime(runtime, {
                    sandboxId: "sandbox-success",
                    rootDir,
                    config: { image: "ghcr.io/acme/smithers:latest", extra: true },
                    executeChildWorkflow: async (parentWorkflow, options) => {
                        childCalls.push({ parentWorkflow, options });
                        writeChildLog(rootDir, "child-success", "{\"stage\":\"done\"}\n");
                        return {
                            runId: "child-success",
                            status: "finished",
                            output: { answer: 42 },
                        };
                    },
                }),
            );

            expect(output).toEqual({ answer: 42 });
            expect(childCalls).toHaveLength(1);
            expect(childCalls[0].parentWorkflow).toEqual({ build: expect.any(Function) });
            expect(childCalls[0].options).toMatchObject({
                parentRunId: "parent-run",
                rootDir,
                allowNetwork: false,
                maxOutputBytes: 1024,
                toolTimeoutMs: 250,
                input: { prompt: "ship it" },
            });
            expect(childCalls[0].options.signal).toBe(runtime.signal);

            const sandbox = await adapter.getSandbox("parent-run", "sandbox-success");
            expect(sandbox).toMatchObject({
                runId: "parent-run",
                sandboxId: "sandbox-success",
                runtime: "codeplane",
                remoteRunId: "child-success",
                workspaceId: "parent-run:sandbox-success",
                status: "finished",
            });
            expect(JSON.parse(String(sandbox.configJson))).toMatchObject({
                runtime: "codeplane",
                selectedRuntime: "codeplane",
                allowNetwork: false,
                maxOutputBytes: 1024,
                toolTimeoutMs: 250,
                reviewDiffs: false,
                autoAcceptDiffs: false,
                image: "ghcr.io/acme/smithers:latest",
                extra: true,
            });
            expect(existsSync(String(sandbox.bundlePath))).toBe(true);

            expect(
                existsSync(join(rootDir, ".smithers", "sandboxes", "parent-run", "sandbox-success", "request")),
            ).toBe(false);

            const resultReadme = JSON.parse(
                readFileSync(join(String(sandbox.bundlePath), "README.md"), "utf8"),
            );
            expect(resultReadme).toEqual({
                outputs: { answer: 42 },
                status: "finished",
                runId: "child-success",
                patches: [],
            });
            expect(
                readFileSync(join(String(sandbox.bundlePath), "logs", "stream.ndjson"), "utf8"),
            ).toBe("{\"stage\":\"done\"}\n");

            expect(heartbeats.map((entry) => entry.stage)).toEqual([
                "initializing",
                "created",
                "shipped",
                "executing",
                "child-finished",
                "bundle-collected",
                "completed",
            ]);
            expect(await eventTypes(adapter, "parent-run")).toEqual([
                "SandboxCreated",
                "SandboxShipped",
                "SandboxHeartbeat",
                "SandboxBundleReceived",
                "SandboxCompleted",
            ]);
        }
        finally {
            sqlite.close();
        }
    });

    test("rejects sandbox execution when no runtime database is available", async () => {
        const runtime = createRuntime(undefined);

        await expect(
            runInRuntime(runtime, {
                sandboxId: "sandbox-no-db",
                parentWorkflow: { build: () => null },
            }),
        ).rejects.toThrow("Sandbox execution requires a task runtime database");
    });

    test("runs a registered provider, materializes its bundle, and applies accepted diff bundles", async () => {
        const { adapter, db, sqlite } = createDb();
        const rootDir = tempDir("smithers-sandbox-provider-");
        const runtime = createRuntime(db, { runId: "run-provider" });
        const providerRequests = [];
        const applyCalls = [];
        const unregister = registerSandboxProvider({
            id: "remote-provider",
            run: async (request) => {
                providerRequests.push(request);
                expect(request).toMatchObject({
                    runId: "run-provider",
                    sandboxId: "sandbox-provider",
                    rootDir,
                    allowNetwork: true,
                    maxOutputBytes: 1024,
                    toolTimeoutMs: 250,
                    config: { region: "us-east-1" },
                });
                return {
                    status: "finished",
                    output: { answer: 42 },
                    runId: "remote-run-1",
                    workspaceId: "workspace-1",
                    containerId: "container-1",
                    diffBundle: onePatchDiffBundle(),
                };
            },
        });
        try {
            const output = await runInRuntime(runtime, {
                sandboxId: "sandbox-provider",
                provider: "remote-provider",
                runtime: undefined,
                rootDir,
                allowNetwork: true,
                reviewDiffs: false,
                config: { region: "us-east-1" },
                applyDiffBundle: async (bundle, targetDir) => {
                    applyCalls.push({ bundle, targetDir });
                },
            });

            expect(output).toEqual({ answer: 42 });
            expect(providerRequests).toHaveLength(1);
            expect(applyCalls).toEqual([
                {
                    bundle: onePatchDiffBundle(),
                    targetDir: rootDir,
                },
            ]);

            const sandbox = await adapter.getSandbox("run-provider", "sandbox-provider");
            expect(sandbox).toMatchObject({
                runtime: "remote-provider",
                remoteRunId: "remote-run-1",
                workspaceId: "workspace-1",
                containerId: "container-1",
                status: "finished",
            });
            expect(JSON.parse(String(sandbox.configJson))).toMatchObject({
                provider: "remote-provider",
                selectedRuntime: "remote-provider",
                allowNetwork: true,
                region: "us-east-1",
            });
            const manifest = JSON.parse(readFileSync(join(String(sandbox.bundlePath), "README.md"), "utf8"));
            expect(manifest).toMatchObject({
                outputs: { answer: 42 },
                status: "finished",
                runId: "remote-run-1",
                diffBundle: onePatchDiffBundle(),
            });
            expect(await eventTypes(adapter, "run-provider")).toEqual([
                "SandboxCreated",
                "SandboxShipped",
                "SandboxBundleReceived",
                "SandboxCompleted",
            ]);
        }
        finally {
            unregister();
            sqlite.close();
        }
    });

    test("passes egress config into provider-backed sandboxes and redacts persisted values", async () => {
        const { adapter, db, sqlite } = createDb();
        const rootDir = tempDir("smithers-sandbox-egress-provider-");
        const runtime = createRuntime(db, { runId: "run-egress-provider" });
        const providerRequests = [];
        const caPem = "-----BEGIN CERTIFICATE-----\nproxy-ca\n-----END CERTIFICATE-----\n";
        try {
            const output = await runInRuntime(runtime, {
                sandboxId: "sandbox-egress-provider",
                provider: {
                    id: "egress-provider",
                    run: async (request) => {
                        providerRequests.push(request);
                        expect(request.egress).toEqual({
                            env: { HTTP_PROXY: "http://127.0.0.1:8080" },
                            httpProxy: "http://127.0.0.1:8080",
                            httpsProxy: "http://127.0.0.1:8080",
                            noProxy: "127.0.0.1,localhost",
                            caCertPem: caPem,
                            secretBindings: { "sk-proxy-anthropic": "anthropic" },
                        });
                        expect(
                            readFileSync(join(request.requestBundlePath, ".smithers", "egress", "ca.crt"), "utf8"),
                        ).toBe(caPem);
                        return {
                            status: "finished",
                            output: {
                                proxy: request.egress?.httpsProxy,
                                caPath: join(request.requestBundlePath, ".smithers", "egress", "ca.crt"),
                            },
                            runId: "remote-egress",
                        };
                    },
                },
                runtime: undefined,
                rootDir,
                reviewDiffs: false,
                config: {
                    egress: {
                        env: { HTTP_PROXY: "http://127.0.0.1:8080" },
                        httpProxy: "http://127.0.0.1:8080",
                        httpsProxy: "http://127.0.0.1:8080",
                        noProxy: ["127.0.0.1", "localhost"],
                        caCertPem: caPem,
                        secretBindings: { "sk-proxy-anthropic": "anthropic" },
                    },
                },
            });

            expect(output).toMatchObject({
                proxy: "http://127.0.0.1:8080",
            });
            expect(providerRequests).toHaveLength(1);
            const sandbox = await adapter.getSandbox("run-egress-provider", "sandbox-egress-provider");
            const config = JSON.parse(String(sandbox.configJson));
            expect(config.egress).toEqual({
                env: { HTTP_PROXY: "[redacted]" },
                httpProxy: "[redacted]",
                httpsProxy: "[redacted]",
                noProxy: "[redacted]",
                caCertPem: "[redacted]",
                secretBindings: { binding_1: "[redacted]" },
            });
            expect(String(sandbox.configJson)).not.toContain("proxy-ca");
            expect(String(sandbox.configJson)).not.toContain("sk-proxy-anthropic");
        }
        finally {
            sqlite.close();
        }
    });

    test("provider diff bundles require review unless auto-accepted", async () => {
        const { adapter, db, sqlite } = createDb();
        const rootDir = tempDir("smithers-sandbox-provider-review-");
        const runtime = createRuntime(db, { runId: "run-provider-review" });
        let applied = false;
        try {
            await expect(
                runInRuntime(runtime, {
                    sandboxId: "sandbox-provider-review",
                    provider: {
                        id: "review-provider",
                        run: async () => ({
                            status: "finished",
                            output: { changed: true },
                            runId: "remote-review",
                            diffBundle: onePatchDiffBundle(),
                        }),
                    },
                    runtime: undefined,
                    rootDir,
                    reviewDiffs: true,
                    autoAcceptDiffs: false,
                    applyDiffBundle: async () => {
                        applied = true;
                    },
                }),
            ).rejects.toThrow("require review approval");

            expect(applied).toBe(false);
            expect(await adapter.getSandbox("run-provider-review", "sandbox-provider-review")).toMatchObject({
                status: "failed",
            });
            expect(await eventTypes(adapter, "run-provider-review")).toEqual([
                "SandboxCreated",
                "SandboxShipped",
                "SandboxBundleReceived",
                "SandboxDiffReviewRequested",
                "SandboxDiffRejected",
                "SandboxFailed",
            ]);
        }
        finally {
            sqlite.close();
        }
    });

    test("provider cleanup runs after provider result failures", async () => {
        const { db, sqlite } = createDb();
        const runtime = createRuntime(db, { runId: "run-provider-cleanup" });
        const cleanupCalls = [];
        try {
            await expect(
                runInRuntime(runtime, {
                    sandboxId: "sandbox-provider-cleanup",
                    provider: {
                        id: "cleanup-provider",
                        run: async () => ({ output: { missing: "status" } }),
                        cleanup: async (request) => cleanupCalls.push(request.sandboxId),
                    },
                    runtime: undefined,
                }),
            ).rejects.toThrow("must include either bundlePath or status");

            expect(cleanupCalls).toEqual(["sandbox-provider-cleanup"]);
        }
        finally {
            sqlite.close();
        }
    });

    test("materializes provider bundle paths and rejects invalid provider results", async () => {
        const resultPath = tempDir("smithers-provider-materialized-");
        const materialized = await __executeSandboxInternals.materializeProviderResult(
            {
                bundlePath: resultPath,
                remoteRunId: "remote-run",
                workspaceId: "workspace-1",
                containerId: "container-1",
            },
            tempDir("smithers-provider-default-"),
        );

        expect(materialized).toEqual({
            bundlePath: resultPath,
            remoteRunId: "remote-run",
            workspaceId: "workspace-1",
            containerId: "container-1",
        });
        await expect(
            __executeSandboxInternals.materializeProviderResult(null, tempDir("smithers-provider-null-")),
        ).rejects.toThrow("invalid result");
        await expect(
            __executeSandboxInternals.materializeProviderResult(
                { status: "running" },
                tempDir("smithers-provider-status-"),
            ),
        ).rejects.toThrow("must include either bundlePath or status");
    });

    test("rejects accepted provider diff bundles without an applier", async () => {
        const { adapter, db, sqlite } = createDb();
        const runtime = createRuntime(db, { runId: "run-provider-no-applier" });
        try {
            await expect(
                runInRuntime(runtime, {
                    sandboxId: "sandbox-provider-no-applier",
                    provider: {
                        id: "no-applier-provider",
                        run: async () => ({
                            status: "finished",
                            output: { changed: true },
                            diffBundle: onePatchDiffBundle(),
                        }),
                    },
                    runtime: undefined,
                    reviewDiffs: false,
                }),
            ).rejects.toThrow("no diff applier was provided");

            expect(await adapter.getSandbox("run-provider-no-applier", "sandbox-provider-no-applier")).toMatchObject({
                status: "failed",
            });
        }
        finally {
            sqlite.close();
        }
    });

    test("rejects malformed accepted provider diff bundles before applying", async () => {
        const { adapter, db, sqlite } = createDb();
        const runtime = createRuntime(db, { runId: "run-provider-bad-diff" });
        let applied = false;
        try {
            await expect(
                runInRuntime(runtime, {
                    sandboxId: "sandbox-provider-bad-diff",
                    provider: {
                        id: "bad-diff-provider",
                        run: async () => ({
                            status: "finished",
                            output: { changed: true },
                            diffBundle: { patches: [] },
                        }),
                    },
                    runtime: undefined,
                    reviewDiffs: false,
                    applyDiffBundle: async () => {
                        applied = true;
                    },
                }),
            ).rejects.toThrow("diffBundle is malformed");

            expect(applied).toBe(false);
            expect(await adapter.getSandbox("run-provider-bad-diff", "sandbox-provider-bad-diff")).toMatchObject({
                status: "failed",
            });
        }
        finally {
            sqlite.close();
        }
    });

    test("runs configured transport commands through the selected executor", async () => {
        const { adapter, db, sqlite } = createDb();
        const runtime = createRuntime(db, { runId: "run-transport-command" });
        let childCalled = false;
        try {
            await expect(
                withCodeplaneEnv(() =>
                    runInRuntime(runtime, {
                        sandboxId: "sandbox-transport-command",
                        config: { command: "echo should-run-in-sandbox" },
                        executeChildWorkflow: async () => {
                            childCalled = true;
                            return { runId: "child-never", status: "finished", output: {} };
                        },
                    }),
                ),
            ).rejects.toThrow("Codeplane sandbox command execution requires");

            expect(childCalled).toBe(false);
            expect(await adapter.getSandbox("run-transport-command", "sandbox-transport-command")).toMatchObject({
                status: "failed",
                workspaceId: "run-transport-command:sandbox-transport-command",
            });
        }
        finally {
            sqlite.close();
        }
    });

    test("rejects unknown providers before running sandbox work", async () => {
        const { adapter, db, sqlite } = createDb();
        const runtime = createRuntime(db, { runId: "run-provider-missing" });
        try {
            await expect(
                runInRuntime(runtime, {
                    provider: "missing-provider",
                    runtime: undefined,
                }),
            ).rejects.toThrow('Sandbox provider "missing-provider" is not registered');
            expect(await eventTypes(adapter, "run-provider-missing")).toEqual([]);
        }
        finally {
            sqlite.close();
        }
    });

    test("rejects nested sandbox execution by default and allows it explicitly", async () => {
        const { adapter, db, sqlite } = createDb();
        const rootDir = tempDir("smithers-sandbox-nested-");
        const runtime = createRuntime(db, { runId: "run-nested" });
        const parentContext = {
            depth: 1,
            sandboxId: "outer",
            runId: "run-nested",
            providerId: "outer-provider",
        };
        const provider = {
            id: "inner-provider",
            run: async () => ({ status: "finished", output: { nested: true }, runId: "inner-run" }),
        };
        try {
            await expect(
                __executeSandboxInternals.sandboxExecutionContext.run(parentContext, () =>
                    runInRuntime(runtime, {
                        sandboxId: "inner-blocked",
                        provider,
                        runtime: undefined,
                        rootDir,
                    }),
                ),
            ).rejects.toThrow("Nested <Sandbox> execution is disabled");

            const output = await __executeSandboxInternals.sandboxExecutionContext.run(parentContext, () =>
                runInRuntime(runtime, {
                    sandboxId: "inner-allowed",
                    provider,
                    runtime: undefined,
                    rootDir,
                    allowNested: true,
                }),
            );

            expect(output).toEqual({ nested: true });
            expect(await adapter.getSandbox("run-nested", "inner-blocked")).toBeUndefined();
            expect(await adapter.getSandbox("run-nested", "inner-allowed")).toMatchObject({
                runtime: "inner-provider",
                remoteRunId: "inner-run",
                status: "finished",
            });
        }
        finally {
            sqlite.close();
        }
    });

    test("redacts sandbox env values in persisted config while passing controls to transport", async () => {
        const { adapter, db, sqlite } = createDb();
        const runtime = createRuntime(db, { runId: "run-redacted-env" });
        try {
            await withCodeplaneEnv(() =>
                runInRuntime(runtime, {
                    sandboxId: "sandbox-redacted-env",
                    config: {
                        env: { SECRET_TOKEN: "secret-value" },
                        workspace: { name: "review-workspace" },
                    },
                }),
            );
            const sandbox = await adapter.getSandbox("run-redacted-env", "sandbox-redacted-env");
            expect(JSON.parse(String(sandbox.configJson))).toMatchObject({
                env: { SECRET_TOKEN: "[redacted]" },
                workspace: { name: "review-workspace" },
            });
            expect(String(sandbox.configJson)).not.toContain("secret-value");
        }
        finally {
            sqlite.close();
        }
    });

    test("marks the sandbox failed when the child workflow executor is missing", async () => {
        const { adapter, db, sqlite } = createDb();
        const heartbeats = [];
        const runtime = createRuntime(db, { heartbeats });
        try {
            await expect(
                withCodeplaneEnv(() =>
                    runInRuntime(runtime, {
                        sandboxId: "sandbox-no-child",
                        executeChildWorkflow: undefined,
                    }),
                ),
            ).rejects.toThrow("missing a child workflow executor");

            const sandbox = await adapter.getSandbox("parent-run", "sandbox-no-child");
            expect(sandbox).toMatchObject({
                sandboxId: "sandbox-no-child",
                status: "failed",
                runtime: "codeplane",
                workspaceId: "parent-run:sandbox-no-child",
            });
            expect(heartbeats.map((entry) => entry.stage)).toEqual([
                "initializing",
                "created",
                "shipped",
                "executing",
                "failed",
            ]);
            expect(await eventTypes(adapter, "parent-run")).toEqual([
                "SandboxCreated",
                "SandboxShipped",
                "SandboxFailed",
            ]);
        }
        finally {
            sqlite.close();
        }
    });

    test("enforces the per-run sandbox concurrency limit before creating a new sandbox", async () => {
        const { adapter, db, sqlite } = createDb();
        const previousLimit = process.env.SMITHERS_MAX_CONCURRENT_SANDBOXES;
        const runtime = createRuntime(db, { runId: "run-at-capacity" });
        let childCalled = false;
        try {
            process.env.SMITHERS_MAX_CONCURRENT_SANDBOXES = "1.8";
            await adapter.upsertSandbox({
                runId: "run-at-capacity",
                sandboxId: "active-sandbox",
                runtime: "codeplane",
                remoteRunId: null,
                workspaceId: null,
                containerId: null,
                configJson: "{}",
                status: "shipped",
                shippedAtMs: 1,
                completedAtMs: null,
                bundlePath: null,
            });
            await adapter.upsertSandbox({
                runId: "run-at-capacity",
                sandboxId: "finished-sandbox",
                runtime: "codeplane",
                remoteRunId: null,
                workspaceId: null,
                containerId: null,
                configJson: "{}",
                status: "finished",
                shippedAtMs: 1,
                completedAtMs: 2,
                bundlePath: null,
            });

            await expect(
                withCodeplaneEnv(() =>
                    runInRuntime(runtime, {
                        sandboxId: "blocked-sandbox",
                        executeChildWorkflow: async () => {
                            childCalled = true;
                            return { runId: "child-never", status: "finished", output: {} };
                        },
                    }),
                ),
            ).rejects.toThrow("concurrency limit reached");

            expect(childCalled).toBe(false);
            expect(await adapter.getSandbox("run-at-capacity", "blocked-sandbox")).toMatchObject({
                status: "failed",
                bundlePath: null,
                workspaceId: null,
            });
            expect(await eventTypes(adapter, "run-at-capacity")).toEqual(["SandboxFailed"]);
        }
        finally {
            if (previousLimit === undefined) {
                delete process.env.SMITHERS_MAX_CONCURRENT_SANDBOXES;
            }
            else {
                process.env.SMITHERS_MAX_CONCURRENT_SANDBOXES = previousLimit;
            }
            sqlite.close();
        }
    });

    test("rejects patch bundles when diff review has not been accepted", async () => {
        const { adapter, db, sqlite } = createDb();
        const rootDir = tempDir("smithers-sandbox-execute-");
        const heartbeats = [];
        const runtime = createRuntime(db, { runId: "run-review", heartbeats });
        try {
            await expect(
                withCodeplaneEnv(() =>
                    runInRuntime(runtime, {
                        sandboxId: "sandbox-review",
                        rootDir,
                        reviewDiffs: true,
                        executeChildWorkflow: async () => {
                            const patchDir = join(resultPath(rootDir, "run-review", "sandbox-review"), "patches");
                            mkdirSync(patchDir, { recursive: true });
                            writeFileSync(
                                join(patchDir, "0001-change.patch"),
                                "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n",
                                "utf8",
                            );
                            return {
                                runId: "child-review",
                                status: "finished",
                                output: { changed: true },
                            };
                        },
                    }),
                ),
            ).rejects.toThrow("require review approval");

            expect(await adapter.getSandbox("run-review", "sandbox-review")).toMatchObject({
                status: "failed",
                bundlePath: resultPath(rootDir, "run-review", "sandbox-review"),
            });
            expect(heartbeats.map((entry) => entry.stage)).toEqual([
                "initializing",
                "created",
                "shipped",
                "executing",
                "child-finished",
                "bundle-collected",
                "failed",
            ]);
            expect(await eventTypes(adapter, "run-review")).toEqual([
                "SandboxCreated",
                "SandboxShipped",
                "SandboxHeartbeat",
                "SandboxBundleReceived",
                "SandboxDiffReviewRequested",
                "SandboxDiffRejected",
                "SandboxFailed",
            ]);
        }
        finally {
            sqlite.close();
        }
    });

    test("auto-accepts patch bundles and records failed child status without throwing", async () => {
        const { adapter, db, sqlite } = createDb();
        const rootDir = tempDir("smithers-sandbox-execute-");
        const runtime = createRuntime(db, { runId: "run-auto-accept" });
        try {
            const output = await withCodeplaneEnv(() =>
                runInRuntime(runtime, {
                    sandboxId: "sandbox-auto",
                    rootDir,
                    reviewDiffs: true,
                    autoAcceptDiffs: true,
                    executeChildWorkflow: async () => {
                        const patchDir = join(resultPath(rootDir, "run-auto-accept", "sandbox-auto"), "patches");
                        mkdirSync(patchDir, { recursive: true });
                        writeFileSync(
                            join(patchDir, "0001-fix.patch"),
                            "diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-fail\n+ok\n",
                            "utf8",
                        );
                        return {
                            runId: "child-auto",
                            status: "failed",
                            output: { reason: "child failed after producing a patch" },
                        };
                    },
                }),
            );

            expect(output).toEqual({ reason: "child failed after producing a patch" });
            const sandbox = await adapter.getSandbox("run-auto-accept", "sandbox-auto");
            expect(sandbox).toMatchObject({
                remoteRunId: "child-auto",
                status: "failed",
                bundlePath: resultPath(rootDir, "run-auto-accept", "sandbox-auto"),
            });
            expect(
                JSON.parse(readFileSync(join(String(sandbox.bundlePath), "README.md"), "utf8")),
            ).toMatchObject({
                outputs: { reason: "child failed after producing a patch" },
                status: "failed",
                runId: "child-auto",
            });
            expect(await eventTypes(adapter, "run-auto-accept")).toEqual([
                "SandboxCreated",
                "SandboxShipped",
                "SandboxHeartbeat",
                "SandboxBundleReceived",
                "SandboxDiffReviewRequested",
                "SandboxDiffAccepted",
                "SandboxCompleted",
            ]);
        }
        finally {
            sqlite.close();
        }
    });
});

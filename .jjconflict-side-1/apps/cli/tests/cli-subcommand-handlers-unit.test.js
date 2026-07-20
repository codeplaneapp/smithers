import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Cli } from "incur";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";

const previousDisableAutoMain = process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN = "1";
const { cli } = await import("../src/index.js");
if (previousDisableAutoMain === undefined) {
    delete process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
}
else {
    process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN = previousDisableAutoMain;
}

const tempDirs = [];
const ORIGINAL_ENV = {
    SMITHERS_HOME: process.env.SMITHERS_HOME,
    SMITHERS_TOKEN_STORE: process.env.SMITHERS_TOKEN_STORE,
    SMITHERS_WORKFLOW_PATHS: process.env.SMITHERS_WORKFLOW_PATHS,
};
const originalCwd = process.cwd();

afterEach(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    while (tempDirs.length) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-cli-handlers-"));
    tempDirs.push(dir);
    return dir;
}

/**
 * Point SMITHERS_HOME at a path that does not exist so neither the real
 * ~/.smithers global pack nor the real accounts.json can leak into a test.
 */
function isolateHome() {
    const home = join(tempDir(), "smithers-home");
    process.env.SMITHERS_HOME = home;
    delete process.env.SMITHERS_WORKFLOW_PATHS;
    return home;
}

/**
 * A minimal on-disk workspace that findAndOpenDb resolves: a `.smithers/`
 * anchor pinning the sqlite backend and a schema-complete smithers.db at the
 * workspace root (read-mode opens execute no DDL, so seeding must migrate).
 */
function seedWorkspace() {
    const dir = tempDir();
    mkdirSync(join(dir, ".smithers"), { recursive: true });
    writeFileSync(join(dir, ".smithers", "smithers.config.ts"), 'export default { backend: "sqlite" };\n');
    const sqlite = new Database(join(dir, "smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { dir, sqlite, adapter: new SmithersDb(db) };
}

/**
 * @param {Partial<import("@smithers-orchestrator/db/adapter").AlertRow>} [overrides]
 */
function alertRow(overrides = {}) {
    return {
        alertId: "alert-1",
        runId: "run-1",
        policyName: "run_failed",
        severity: "critical",
        status: "firing",
        firedAtMs: 1_000,
        resolvedAtMs: null,
        acknowledgedAtMs: null,
        message: "Run failed",
        detailsJson: '{"source":"test"}',
        fingerprint: null,
        nodeId: null,
        iteration: null,
        owner: null,
        runbook: null,
        labelsJson: null,
        reactionJson: null,
        sourceEventType: null,
        firstFiredAtMs: null,
        lastFiredAtMs: null,
        occurrenceCount: 1,
        silencedUntilMs: null,
        acknowledgedBy: null,
        resolvedBy: null,
        ...overrides,
    };
}

function rootCommands() {
    const commands = Cli.toCommands.get(cli);
    if (!(commands instanceof Map)) throw new Error("Smithers CLI command registry was not available");
    return commands;
}

function leaf(commandPath) {
    let entry;
    let scope = rootCommands();
    for (const token of commandPath.split(" ")) {
        entry = scope.get(token);
        if (!entry) throw new Error(`Missing CLI command: ${commandPath}`);
        scope = entry._group ? entry.commands : undefined;
    }
    if (entry?._group) throw new Error(`Expected leaf command, got group: ${commandPath}`);
    return entry;
}

function parseOptions(commandPath, options = {}) {
    return leaf(commandPath).options?.parse(options) ?? {};
}

async function runLeaf(commandPath, { args = {}, options = {}, format = "json" } = {}) {
    const entry = leaf(commandPath);
    return await entry.run({
        args,
        options,
        format,
        ok(data, meta) {
            return { ok: true, data, meta };
        },
        error(error) {
            return { ok: false, error };
        },
    });
}

async function inDir(dir, fn) {
    process.chdir(dir);
    try {
        return await fn();
    }
    finally {
        process.chdir(originalCwd);
    }
}

describe("CLI_ALERTS actions against a seeded workspace store", () => {
    test("list returns zero alerts on an empty store in both machine and human formats", async () => {
        isolateHome();
        const { dir, sqlite } = seedWorkspace();
        sqlite.close();
        await inDir(dir, async () => {
            const machine = await runLeaf("alerts", { args: { action: "list" }, format: "json" });
            expect(machine).toMatchObject({ ok: true, data: { alerts: [] } });

            const human = await runLeaf("alerts", { args: { action: "list" }, format: "human" });
            expect(human.ok).toBe(true);
            expect(human.data).toBe("No active alerts.");
        });
    });

    test("list maps timestamps to ISO strings and excludes resolved alerts", async () => {
        isolateHome();
        const { dir, sqlite, adapter } = seedWorkspace();
        await adapter.insertAlert(alertRow({ alertId: "a-firing" }));
        await adapter.insertAlert(alertRow({ alertId: "a-ack" }));
        await adapter.insertAlert(alertRow({ alertId: "a-silence" }));
        await adapter.insertAlert(alertRow({ alertId: "a-resolve" }));
        await adapter.acknowledgeAlert("a-ack", 5_000);
        await adapter.silenceAlert("a-silence");
        await adapter.resolveAlert("a-resolve", 7_000);
        sqlite.close();

        await inDir(dir, async () => {
            const result = await runLeaf("alerts", { args: { action: "list" }, format: "json" });
            expect(result.ok).toBe(true);
            const ids = new Set(result.data.alerts.map((alert) => alert.alertId));
            expect(ids).toEqual(new Set(["a-firing", "a-ack", "a-silence"]));

            const acked = result.data.alerts.find((alert) => alert.alertId === "a-ack");
            expect(acked).toMatchObject({
                status: "acknowledged",
                policyName: "run_failed",
                severity: "critical",
                runId: "run-1",
                firedAtMs: 1_000,
                firedAt: "1970-01-01T00:00:01.000Z",
                acknowledgedAtMs: 5_000,
                acknowledgedAt: "1970-01-01T00:00:05.000Z",
                resolvedAtMs: null,
                resolvedAt: null,
            });
            expect(typeof acked.age).toBe("string");
        });
    });

    test("ack normalizes action casing and trims the alert id before mutating", async () => {
        isolateHome();
        const { dir, sqlite, adapter } = seedWorkspace();
        await adapter.insertAlert(alertRow({ alertId: "a-firing" }));
        sqlite.close();

        await inDir(dir, async () => {
            const result = await runLeaf("alerts", {
                args: { action: " ACK ", alertId: "  a-firing  " },
                format: "json",
            });
            expect(result.ok).toBe(true);
            expect(result.data).toMatchObject({ alertId: "a-firing", status: "acknowledged" });
            expect(typeof result.data.acknowledgedAtMs).toBe("number");
        });
    });

    test("resolve and silence transition a firing alert and report the new status", async () => {
        isolateHome();
        const { dir, sqlite, adapter } = seedWorkspace();
        await adapter.insertAlert(alertRow({ alertId: "a-resolve" }));
        await adapter.insertAlert(alertRow({ alertId: "a-silence" }));
        sqlite.close();

        await inDir(dir, async () => {
            const resolved = await runLeaf("alerts", {
                args: { action: "resolve", alertId: "a-resolve" },
                format: "json",
            });
            expect(resolved.ok).toBe(true);
            expect(resolved.data).toMatchObject({ alertId: "a-resolve", status: "resolved" });

            const silenced = await runLeaf("alerts", {
                args: { action: "silence", alertId: "a-silence" },
                format: "human",
            });
            expect(silenced.ok).toBe(true);
            expect(silenced.data).toBe("Alert a-silence is silenced.");
        });
    });

    test("mutating an unknown alert id fails with ALERT_NOT_FOUND and exit code 4", async () => {
        isolateHome();
        const { dir, sqlite } = seedWorkspace();
        sqlite.close();

        await inDir(dir, async () => {
            const result = await runLeaf("alerts", {
                args: { action: "ack", alertId: "ghost" },
                format: "json",
            });
            expect(result).toMatchObject({
                ok: false,
                error: { code: "ALERT_NOT_FOUND", exitCode: 4 },
            });
            expect(result.error.message).toContain("ghost");
        });
    });

    test("alerts fails with ALERTS_FAILED and exit code 1 when no workspace store exists", async () => {
        isolateHome();
        const dir = tempDir();
        await inDir(dir, async () => {
            const result = await runLeaf("alerts", { args: { action: "list" }, format: "json" });
            expect(result).toMatchObject({
                ok: false,
                error: { code: "ALERTS_FAILED", exitCode: 1 },
            });
        });
    });
});

describe("CLI_CLAUDE protocol command handler error mapping", () => {
    test("claude monitor exits clean and silent when the directory has no smithers store", async () => {
        isolateHome();
        const dir = tempDir();
        await inDir(dir, async () => {
            const result = await runLeaf("claude monitor", {
                options: parseOptions("claude monitor"),
            });
            expect(result).toEqual({ ok: true, data: undefined, meta: undefined });
        });
    });

    test("claude tick without --wait surfaces a missing store as exit code 1", async () => {
        isolateHome();
        const dir = tempDir();
        await inDir(dir, async () => {
            const result = await runLeaf("claude tick", {
                args: { runId: "run-missing" },
                options: parseOptions("claude tick"),
            });
            expect(result).toMatchObject({
                ok: false,
                error: { code: "CLI_DB_NOT_FOUND", exitCode: 1 },
            });
        });
    });

    test("claude tick maps an unknown run to RUN_NOT_FOUND with exit code 4", async () => {
        isolateHome();
        const { dir, sqlite } = seedWorkspace();
        sqlite.close();
        await inDir(dir, async () => {
            const result = await runLeaf("claude tick", {
                args: { runId: "run-missing" },
                options: parseOptions("claude tick"),
            });
            expect(result).toMatchObject({
                ok: false,
                error: { code: "RUN_NOT_FOUND", exitCode: 4 },
            });
            expect(result.error.message).toContain("run-missing");
        });
    });

    test("claude node-wait maps an unknown run to RUN_NOT_FOUND with exit code 4", async () => {
        isolateHome();
        const { dir, sqlite } = seedWorkspace();
        sqlite.close();
        await inDir(dir, async () => {
            const result = await runLeaf("claude node-wait", {
                args: { nodeId: "node-1" },
                options: parseOptions("claude node-wait", { runId: "run-missing" }),
            });
            expect(result).toMatchObject({
                ok: false,
                error: { code: "RUN_NOT_FOUND", exitCode: 4 },
            });
        });
    });
});

describe("CLI_MEMORY subcommands without a resolvable workspace", () => {
    test("list, get, set, and rm each fail with their own code and point at smithers init", async () => {
        isolateHome();
        const dir = tempDir();
        const cases = [
            { path: "memory list", args: {}, code: "MEMORY_LIST_FAILED" },
            { path: "memory get", args: { namespace: "workflow:x", key: "k" }, code: "MEMORY_GET_FAILED" },
            { path: "memory set", args: { namespace: "workflow:x", key: "k", value: "v" }, code: "MEMORY_SET_FAILED" },
            { path: "memory rm", args: { namespace: "workflow:x", key: "k" }, code: "MEMORY_RM_FAILED" },
        ];
        await inDir(dir, async () => {
            for (const { path, args, code } of cases) {
                const result = await runLeaf(path, { args, options: parseOptions(path) });
                expect(result.ok).toBe(false);
                expect(result.error.code).toBe(code);
                expect(result.error.message).toContain("smithers init");
            }
        });
    });
});

describe("CLI_WORKFLOW subcommands in an uninitialized directory", () => {
    test("workflow list returns zero workflows with and without --system", async () => {
        isolateHome();
        const dir = tempDir();
        await inDir(dir, async () => {
            const plain = await runLeaf("workflow list", { options: parseOptions("workflow list") });
            expect(plain.ok).toBe(true);
            expect(plain.data.workflows).toEqual([]);

            const system = await runLeaf("workflow list", {
                options: parseOptions("workflow list", { system: true }),
            });
            expect(system.ok).toBe(true);
            expect(system.data.workflows).toEqual([]);
        });
    });

    test("workflow path throws a RUN_NOT_FOUND SmithersError for an unknown id", async () => {
        isolateHome();
        const dir = tempDir();
        await inDir(dir, async () => {
            await expect(runLeaf("workflow path", { args: { name: "no-such-workflow" } }))
                .rejects.toMatchObject({
                    code: "RUN_NOT_FOUND",
                    message: expect.stringContaining("Workflow not found: no-such-workflow"),
                });
        });
    });

    test("workflow skills fails with exit code 4 for an unknown workflow id", async () => {
        isolateHome();
        const dir = tempDir();
        await inDir(dir, async () => {
            const result = await runLeaf("workflow skills", {
                args: { name: "no-such-workflow" },
                options: parseOptions("workflow skills"),
            });
            expect(result).toMatchObject({
                ok: false,
                error: { code: "RUN_NOT_FOUND", exitCode: 4 },
            });
            expect(result.error.message).toContain("no-such-workflow");
        });
    });

    test("workflow doctor reports the fallback pack layout when nothing is installed", async () => {
        isolateHome();
        const dir = tempDir();
        await inDir(dir, async () => {
            const result = await runLeaf("workflow doctor", { args: {}, format: "json" });
            const realDir = realpathSync(dir);
            expect(result.ok).toBe(true);
            expect(result.data.workflows).toEqual([]);
            expect(result.data.packs).toEqual([]);
            expect(result.data.workflowRoot).toBe(resolve(realDir, ".smithers"));
            expect(result.data.preload).toMatchObject({
                path: resolve(realDir, ".smithers", "preload.ts"),
                exists: false,
            });
            expect(result.data.bunfig).toMatchObject({
                path: resolve(realDir, ".smithers", "bunfig.toml"),
                exists: false,
            });
            expect(result.data.vcs).toBeDefined();
            expect(Array.isArray(result.data.agents)).toBe(true);
        });
    });
});

describe("CLI_TOKEN handler edge paths", () => {
    test("revoking an unknown token fails with TOKEN_NOT_FOUND and does not create a store", async () => {
        const storePath = join(tempDir(), "tokens.json");
        process.env.SMITHERS_TOKEN_STORE = storePath;

        const result = await runLeaf("token revoke", {
            args: { token: "smithers_never_issued" },
            options: {},
        });
        expect(result).toMatchObject({
            ok: false,
            error: { code: "TOKEN_NOT_FOUND", exitCode: 1 },
        });
        expect(existsSync(storePath)).toBe(false);
    });

    test("token exec propagates a non-zero child exit code into TOKEN_EXEC_FAILED", async () => {
        process.env.SMITHERS_TOKEN_STORE = join(tempDir(), "tokens.json");

        const issued = await runLeaf("token issue", { options: parseOptions("token issue") });
        expect(issued.ok).toBe(true);

        const result = await runLeaf("token exec", {
            options: parseOptions("token exec", {
                handle: issued.data.actionToken.handle,
                command: "exit 7",
            }),
        });
        expect(result).toMatchObject({
            ok: false,
            error: { code: "TOKEN_EXEC_FAILED", exitCode: 7 },
        });
        expect(result.error.message).toContain("Command exited with status 7");
    });
});

describe("CLI_AGENTS handlers with an isolated account registry", () => {
    test("agents list returns zero accounts from a fresh home", async () => {
        isolateHome();
        const result = await runLeaf("agents list");
        expect(result).toMatchObject({ ok: true, data: { accounts: [] } });
    });

    test("agents test fails with ACCOUNT_NOT_FOUND before spawning anything", async () => {
        isolateHome();
        const result = await runLeaf("agents test", { args: { label: "ghost-account" } });
        expect(result).toMatchObject({
            ok: false,
            error: { code: "ACCOUNT_NOT_FOUND", exitCode: 1 },
        });
        expect(result.error.message).toContain("ghost-account");
    });

    test("agents remove errors on an unknown label unless --silent turns it into removed:false", async () => {
        isolateHome();
        const loud = await runLeaf("agents remove", {
            args: { label: "ghost-account" },
            options: parseOptions("agents remove"),
        });
        expect(loud).toMatchObject({
            ok: false,
            error: { code: "ACCOUNT_NOT_FOUND", exitCode: 1 },
        });

        const silent = await runLeaf("agents remove", {
            args: { label: "ghost-account" },
            options: parseOptions("agents remove", { silent: true }),
        });
        expect(silent).toMatchObject({
            ok: true,
            data: { removed: false, label: "ghost-account" },
        });
    });
});

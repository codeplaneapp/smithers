import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cli } from "incur";

import { parseAgentWiringArgv } from "../src/agent-wiring/parseAgentWiringArgv.js";
import { EXTRA_MCP_AGENTS, EXTRA_SKILL_AGENTS } from "../src/agent-wiring/wireExtraAgents.js";

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
const originalTokenStore = process.env.SMITHERS_TOKEN_STORE;

afterEach(() => {
    while (tempDirs.length) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
    if (originalTokenStore === undefined) {
        delete process.env.SMITHERS_TOKEN_STORE;
    }
    else {
        process.env.SMITHERS_TOKEN_STORE = originalTokenStore;
    }
});

function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-cli-subcommands-"));
    tempDirs.push(dir);
    return dir;
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

function groupCommands(name) {
    const entry = rootCommands().get(name);
    if (!entry?._group) throw new Error(`Missing CLI command group: ${name}`);
    return Array.from(entry.commands.keys()).filter((key) => !key.startsWith("_")).sort();
}

function parseOptions(commandPath, options = {}) {
    return leaf(commandPath).options?.parse(options) ?? {};
}

function parseArgs(commandPath, args = {}) {
    return leaf(commandPath).args?.parse(args) ?? {};
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

describe("CLI_SUBCOMMANDS command registry", () => {
    test("registers the workflow, cron, memory, openapi, agents, token, and claude leaves", () => {
        expect(groupCommands("workflow")).toEqual([
            "create",
            "doctor",
            "inspect",
            "list",
            "path",
            "run",
            "skills",
        ]);
        expect(groupCommands("cron")).toEqual(["add", "list", "rm", "start"]);
        expect(groupCommands("memory")).toEqual(["get", "list", "rm", "set"]);
        expect(groupCommands("openapi")).toEqual(["generate", "list"]);
        expect(groupCommands("agents")).toEqual([
            "add",
            "capabilities",
            "doctor",
            "list",
            "remove",
            "test",
        ]);
        expect(groupCommands("token")).toEqual(["exec", "issue", "revoke"]);
        expect(groupCommands("claude")).toEqual(["monitor", "node-wait", "tick"]);
    });

    test("pins positional order and defaults that are easy to mix up", () => {
        expect(Object.keys(leaf("cron add").args.shape)).toEqual(["pattern", "workflowPath"]);
        expect(Object.keys(leaf("openapi generate").args.shape)).toEqual(["specPath", "outputPath"]);
        expect(Object.keys(leaf("memory set").args.shape)).toEqual(["namespace", "key", "value"]);

        expect(parseOptions("workflow list")).toMatchObject({ system: false });
        expect(parseOptions("workflow create")).toMatchObject({ global: false });
        expect(parseOptions("workflow skills")).toMatchObject({ force: false, global: false });
        expect(parseOptions("memory set", { ttl: "3600000" })).toMatchObject({ ttl: 3600000 });
        expect(parseOptions("token issue")).toMatchObject({
            scopes: "run:read",
            ttl: "1h",
            revealToken: false,
            actionId: "gateway",
        });
        expect(parseOptions("token exec", { handle: "smithers_action_1", command: "echo ok" })).toMatchObject({
            env: "SMITHERS_API_KEY",
            actionId: "gateway",
            scopes: "",
            handle: "smithers_action_1",
            command: "echo ok",
        });
    });

    test("parses the up infrastructure flag surface without invoking a workflow", () => {
        expect(parseArgs("up", { workflow: "workflow.tsx" })).toEqual({ workflow: "workflow.tsx" });
        expect(parseOptions("up", {
            detach: true,
            hot: true,
            input: '{"prompt":"hello"}',
            annotations: '{"source":"test"}',
            runId: "run-override",
            resume: "run-parent",
            force: true,
            maxConcurrency: 7,
            root: "/tmp/workspace",
            log: false,
            logDir: "/tmp/logs",
            allowNetwork: true,
            maxOutputBytes: 65_536,
            toolTimeoutMs: 12_345,
            serve: true,
            supervise: true,
            superviseDryRun: true,
            superviseInterval: "250ms",
            superviseStaleThreshold: "2m",
            superviseMaxConcurrent: 5,
            port: 7332,
            host: "127.0.0.1",
            authToken: "secret-token",
            insecure: false,
            metrics: false,
            backend: "sqlite",
            postFailure: false,
            verbose: true,
            report: false,
        })).toMatchObject({
            detach: true,
            hot: true,
            input: '{"prompt":"hello"}',
            annotations: '{"source":"test"}',
            runId: "run-override",
            resume: "run-parent",
            force: true,
            maxConcurrency: 7,
            root: "/tmp/workspace",
            log: false,
            logDir: "/tmp/logs",
            allowNetwork: true,
            maxOutputBytes: 65_536,
            toolTimeoutMs: 12_345,
            serve: true,
            supervise: true,
            superviseDryRun: true,
            superviseInterval: "250ms",
            superviseStaleThreshold: "2m",
            superviseMaxConcurrent: 5,
            port: 7332,
            host: "127.0.0.1",
            authToken: "secret-token",
            metrics: false,
            backend: "sqlite",
            postFailure: false,
            verbose: true,
            report: false,
        });
    });

    test("rejects unsafe numeric up bounds during option parsing", () => {
        expect(leaf("up").options.safeParse({ maxConcurrency: 0 }).success).toBe(false);
        expect(leaf("up").options.safeParse({ maxOutputBytes: 0 }).success).toBe(false);
        expect(leaf("up").options.safeParse({ toolTimeoutMs: 0 }).success).toBe(false);
        expect(leaf("up").options.safeParse({ superviseMaxConcurrent: 0 }).success).toBe(false);
        expect(leaf("up").options.safeParse({ resumeClaimHeartbeat: 0 }).success).toBe(false);
        expect(leaf("up").options.safeParse({ port: 0 }).success).toBe(false);
        expect(leaf("up").options.safeParse({ port: 65_536 }).success).toBe(false);
    });

    test("validates action-style top-level commands without starting the gateway or opening alerts", () => {
        expect(parseArgs("gateway", { action: "status" })).toEqual({ action: "status" });
        expect(parseArgs("gateway", { action: "stop" })).toEqual({ action: "stop" });
        expect(leaf("gateway").args.safeParse({ action: "restart" }).success).toBe(false);

        expect(Object.keys(leaf("alerts").args.shape)).toEqual(["action", "alertId"]);
        expect(parseArgs("alerts", { action: "list" })).toEqual({ action: "list" });
        expect(parseArgs("alerts", { action: "ack", alertId: "al-1" })).toEqual({
            action: "ack",
            alertId: "al-1",
        });
    });

    test("keeps defensive schema bounds on polling commands", () => {
        expect(leaf("claude tick").options.safeParse({ intervalMs: 99 }).success).toBe(false);
        expect(leaf("claude node-wait").options.safeParse({ intervalMs: 99, runId: "run-1" }).success).toBe(false);
        expect(leaf("claude monitor").options.safeParse({ intervalMs: 249 }).success).toBe(false);
        expect(leaf("gateway").options.safeParse({ port: 65536 }).success).toBe(false);
        expect(leaf("memory set").options.safeParse({ ttl: 0 }).success).toBe(false);
        expect(leaf("memory set").options.safeParse({ ttl: -1 }).success).toBe(false);
    });

    test("parses supplementary MCP and skills wiring for agents incur does not own", () => {
        expect(EXTRA_MCP_AGENTS).toEqual(["hermes", "openclaw"]);
        expect(EXTRA_SKILL_AGENTS).toEqual(["pi"]);
        expect(parseAgentWiringArgv(["mcp", "add", "--agent", "Hermes", "--agent=openclaw"]))
            .toEqual({ kind: "mcp", global: true, agents: ["hermes", "openclaw"] });
        expect(parseAgentWiringArgv(["skills", "add", "--agent", "Pi"]))
            .toEqual({ kind: "skills", global: true, agents: ["pi"] });
    });
});

describe("CLI_SUBCOMMANDS handler error paths", () => {
    test("workflow create rejects invalid workflow names before writing a scaffold", async () => {
        const result = await runLeaf("workflow create", {
            args: { name: "Bad_Name" },
            options: parseOptions("workflow create"),
            format: "json",
        });

        expect(result).toMatchObject({
            ok: false,
            error: {
                code: "INVALID_WORKFLOW_NAME",
                exitCode: 4,
            },
        });
        expect(result.error.message).toContain("Use lowercase kebab-case");
    });

    test("workflow run rejects a missing workflow id in non-interactive machine mode", async () => {
        const result = await runLeaf("workflow run", {
            args: {},
            options: parseOptions("workflow run"),
            format: "json",
        });

        expect(result).toMatchObject({
            ok: false,
            error: {
                code: "WORKFLOW_REQUIRED",
                exitCode: 4,
            },
        });
        expect(result.error.message).toContain("Provide a workflow ID");
    });

    test("alerts rejects unknown actions before touching the workspace DB", async () => {
        const result = await runLeaf("alerts", {
            args: { action: "delete", alertId: "al-1" },
            options: {},
            format: "json",
        });

        expect(result).toMatchObject({
            ok: false,
            error: {
                code: "INVALID_ALERT_ACTION",
                exitCode: 4,
            },
        });
        expect(result.error.message).toContain("delete");
    });

    test("alerts mutating actions require an alert id before touching the workspace DB", async () => {
        for (const action of ["ack", "resolve", "silence"]) {
            const result = await runLeaf("alerts", {
                args: { action },
                options: {},
                format: "json",
            });

            expect(result).toMatchObject({
                ok: false,
                error: {
                    code: "ALERT_ID_REQUIRED",
                    exitCode: 4,
                },
            });
            expect(result.error.message).toContain(`smithers alerts ${action} requires <id>`);
        }
    });

    test("cron add rejects invalid patterns before opening the workspace DB", async () => {
        const result = await runLeaf("cron add", {
            args: { pattern: "not a cron", workflowPath: "workflow.tsx" },
            options: {},
            format: "json",
        });

        expect(result).toMatchObject({
            ok: false,
            error: {
                code: "INVALID_CRON_PATTERN",
                exitCode: 4,
            },
        });
        expect(result.error.message).toContain("not a cron");
    });

    test("token issue rejects invalid ttl values before persisting a token store", async () => {
        const dir = tempDir();
        process.env.SMITHERS_TOKEN_STORE = join(dir, "tokens.json");

        const result = await runLeaf("token issue", {
            options: parseOptions("token issue", { ttl: "0ms" }),
        });

        expect(result).toMatchObject({
            ok: false,
            error: {
                code: "INVALID_DURATION",
                exitCode: 1,
            },
        });
        expect(result.error.message).toContain('Invalid ttl: "0ms" must be > 0');
        expect(existsSync(process.env.SMITHERS_TOKEN_STORE)).toBe(false);
    });

    test("token issue redacts by default and revoke accepts the revealed bearer", async () => {
        const dir = tempDir();
        process.env.SMITHERS_TOKEN_STORE = join(dir, "tokens.json");

        const redacted = await runLeaf("token issue", {
            options: parseOptions("token issue"),
        });
        expect(redacted.ok).toBe(true);
        expect(redacted.data.token).toBeUndefined();
        expect(redacted.data.grant.scopes).toEqual(["run:read"]);
        expect(redacted.data.grant.secret).toBeUndefined();
        expect(redacted.data.actionToken.handle).toStartWith("smithers_action_");

        const revealed = await runLeaf("token issue", {
            options: parseOptions("token issue", {
                revealToken: true,
                scopes: "run:read run:write",
                ttl: "15m",
            }),
        });
        expect(revealed.ok).toBe(true);
        expect(revealed.data.token).toStartWith("smithers_");
        expect(revealed.data.grant.scopes).toEqual(["run:read", "run:write"]);

        const revoked = await runLeaf("token revoke", {
            args: { token: revealed.data.token },
            options: {},
        });
        expect(revoked).toMatchObject({
            ok: true,
            data: {
                revoked: true,
                tokenId: revealed.data.grant.tokenId,
            },
        });
    });

    test("token exec rejects an unknown action handle before spawning a command", async () => {
        const dir = tempDir();
        process.env.SMITHERS_TOKEN_STORE = join(dir, "tokens.json");

        const result = await runLeaf("token exec", {
            options: parseOptions("token exec", {
                handle: "smithers_action_missing",
                command: "echo should-not-run",
            }),
        });

        expect(result).toMatchObject({
            ok: false,
            error: {
                code: "TOKEN_EXEC_FAILED",
                exitCode: 1,
            },
        });
        expect(result.error.message).toContain("Action token handle was not found");
        expect(existsSync(process.env.SMITHERS_TOKEN_STORE)).toBe(false);
    });
});

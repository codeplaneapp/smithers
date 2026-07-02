import { describe, expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    canonicalWorkspacePath,
    claimGatewayAutostartLock,
    clearGatewayRuntimeState,
    discoverWorkspaceGateway,
    gatewayRuntimePaths,
    mintGatewayToken,
    readGatewayRuntimeState,
    verifyGatewayHealthIdentity,
    writeGatewayRuntimeState,
} from "../src/gateway-runtime.js";

function makeEnv() {
    const stateDir = mkdtempSync(join(tmpdir(), "smithers-gwstate-"));
    onTestFinished(() => rmSync(stateDir, { recursive: true, force: true }));
    return { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
}

function makeWorkspace() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-gwws-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/**
 * A real gateway-shaped /health endpoint (no mocks: actual HTTP server).
 *
 * @param {Record<string, unknown> | null} identity
 */
async function serveHealth(identity) {
    const server = createServer((req, res) => {
        if (req.url === "/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocol: 1, features: [], stateVersion: 0, ...(identity ? { identity } : {}) }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}`;
    onTestFinished(() => new Promise((resolve) => server.close(resolve)));
    return { server, url, port: address.port };
}

/**
 * @param {string} workspace
 * @param {{ url: string; port: number }} target
 * @param {Record<string, unknown>} [overrides]
 */
function stateFor(workspace, target, overrides = {}) {
    return {
        pid: process.pid,
        host: "127.0.0.1",
        port: target.port,
        url: target.url,
        token: null,
        workspaceRoot: canonicalWorkspacePath(workspace),
        backend: "sqlite",
        version: "0.0.0-test",
        protocol: 1,
        startedAtMs: Date.now(),
        ...overrides,
    };
}

describe("runtime state file", () => {
    test("write/read round-trips and the file is owner-only", () => {
        const env = makeEnv();
        const workspace = makeWorkspace();
        const path = writeGatewayRuntimeState(workspace, stateFor(workspace, { url: "http://127.0.0.1:1", port: 1 }, { token: mintGatewayToken() }), env);
        const state = readGatewayRuntimeState(workspace, env);
        expect(state?.pid).toBe(process.pid);
        expect(state?.token).toHaveLength(64);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(gatewayRuntimePaths(workspace, env).stateFile).toBe(path);
    });

    test("clear only removes state belonging to the given pid", () => {
        const env = makeEnv();
        const workspace = makeWorkspace();
        writeGatewayRuntimeState(workspace, stateFor(workspace, { url: "http://127.0.0.1:1", port: 1 }, { pid: 12345 }), env);
        clearGatewayRuntimeState(workspace, 99999, env);
        expect(readGatewayRuntimeState(workspace, env)?.pid).toBe(12345);
        clearGatewayRuntimeState(workspace, 12345, env);
        expect(readGatewayRuntimeState(workspace, env)).toBeNull();
    });

    test("malformed state reads as absent", () => {
        const env = makeEnv();
        const workspace = makeWorkspace();
        const { dir, stateFile } = gatewayRuntimePaths(workspace, env);
        mkdirSync(dir, { recursive: true });
        writeFileSync(stateFile, "not json {{{");
        expect(readGatewayRuntimeState(workspace, env)).toBeNull();
    });

    test("distinct workspaces get distinct state files", () => {
        const env = makeEnv();
        const a = makeWorkspace();
        const b = makeWorkspace();
        expect(gatewayRuntimePaths(a, env).stateFile).not.toBe(gatewayRuntimePaths(b, env).stateFile);
    });
});

describe("verifyGatewayHealthIdentity", () => {
    test("matches when the advertised workspace is the resolved workspace", async () => {
        const workspace = makeWorkspace();
        const target = await serveHealth({ workspaceRoot: workspace, backend: "sqlite", version: "1", pid: process.pid, startedAtMs: 1 });
        const identity = await verifyGatewayHealthIdentity(target.url, workspace);
        expect(identity?.pid).toBe(process.pid);
    });

    test("rejects a gateway advertising a different workspace", async () => {
        const workspace = makeWorkspace();
        const other = makeWorkspace();
        const target = await serveHealth({ workspaceRoot: other, backend: "sqlite", version: "1", pid: process.pid, startedAtMs: 1 });
        expect(await verifyGatewayHealthIdentity(target.url, workspace)).toBeNull();
    });

    test("rejects a gateway with no identity on the wire (older library)", async () => {
        const workspace = makeWorkspace();
        const target = await serveHealth(null);
        expect(await verifyGatewayHealthIdentity(target.url, workspace)).toBeNull();
    });

    test("rejects an unreachable url", async () => {
        const workspace = makeWorkspace();
        expect(await verifyGatewayHealthIdentity("http://127.0.0.1:1", workspace)).toBeNull();
    });
});

describe("discoverWorkspaceGateway", () => {
    test("discovers a live, identity-matching gateway", async () => {
        const env = makeEnv();
        const workspace = makeWorkspace();
        const target = await serveHealth({ workspaceRoot: workspace, backend: "sqlite", version: "1", pid: process.pid, startedAtMs: 1 });
        writeGatewayRuntimeState(workspace, stateFor(workspace, target), env);
        const discovered = await discoverWorkspaceGateway(workspace, env);
        expect(discovered?.state.url).toBe(target.url);
    });

    test("cleans up state pointing at a dead pid", async () => {
        const env = makeEnv();
        const workspace = makeWorkspace();
        writeGatewayRuntimeState(workspace, stateFor(workspace, { url: "http://127.0.0.1:1", port: 1 }, { pid: 999999999 }), env);
        expect(await discoverWorkspaceGateway(workspace, env)).toBeNull();
        expect(readGatewayRuntimeState(workspace, env)).toBeNull();
    });

    test("cleans up state whose gateway now serves a different workspace", async () => {
        const env = makeEnv();
        const workspace = makeWorkspace();
        const other = makeWorkspace();
        const target = await serveHealth({ workspaceRoot: other, backend: "sqlite", version: "1", pid: process.pid, startedAtMs: 1 });
        writeGatewayRuntimeState(workspace, stateFor(workspace, target), env);
        expect(await discoverWorkspaceGateway(workspace, env)).toBeNull();
        expect(readGatewayRuntimeState(workspace, env)).toBeNull();
    });

    test("cleans up state whose port stopped answering", async () => {
        const env = makeEnv();
        const workspace = makeWorkspace();
        writeGatewayRuntimeState(workspace, stateFor(workspace, { url: "http://127.0.0.1:1", port: 1 }), env);
        expect(await discoverWorkspaceGateway(workspace, env)).toBeNull();
        expect(readGatewayRuntimeState(workspace, env)).toBeNull();
    });
});

describe("claimGatewayAutostartLock", () => {
    test("second claim from a live fresh holder loses", () => {
        const env = makeEnv();
        const workspace = makeWorkspace();
        const first = claimGatewayAutostartLock(workspace, env);
        expect(first).not.toBeNull();
        expect(claimGatewayAutostartLock(workspace, env)).toBeNull();
        first?.release();
        const third = claimGatewayAutostartLock(workspace, env);
        expect(third).not.toBeNull();
        third?.release();
    });

    test("steals a lock held by a dead pid", () => {
        const env = makeEnv();
        const workspace = makeWorkspace();
        const { dir, lockFile } = gatewayRuntimePaths(workspace, env);
        mkdirSync(dir, { recursive: true });
        writeFileSync(lockFile, JSON.stringify({ pid: 999999999, atMs: Date.now() }));
        const lock = claimGatewayAutostartLock(workspace, env);
        expect(lock).not.toBeNull();
        lock?.release();
    });

    test("steals a stale lock from a live pid", () => {
        const env = makeEnv();
        const workspace = makeWorkspace();
        const { dir, lockFile } = gatewayRuntimePaths(workspace, env);
        mkdirSync(dir, { recursive: true });
        writeFileSync(lockFile, JSON.stringify({ pid: process.pid, atMs: Date.now() - 60_000 }));
        const lock = claimGatewayAutostartLock(workspace, env);
        expect(lock).not.toBeNull();
        lock?.release();
    });

    test("release does not remove a lock another process re-claimed", () => {
        const env = makeEnv();
        const workspace = makeWorkspace();
        const { lockFile } = gatewayRuntimePaths(workspace, env);
        const lock = claimGatewayAutostartLock(workspace, env);
        expect(lock).not.toBeNull();
        // Simulate a steal by another pid between our claim and release.
        writeFileSync(lockFile, JSON.stringify({ pid: process.pid + 1, atMs: Date.now() }));
        lock?.release();
        expect(readFileSync(lockFile, "utf8")).toContain(String(process.pid + 1));
    });
});

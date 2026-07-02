import { expect, onTestFinished, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";
import { gatewayRuntimePaths, readGatewayRuntimeState } from "../src/gateway-runtime.js";

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

function makeStateDirEnv() {
    const stateDir = mkdtempSync(join(tmpdir(), "smithers-gwstate-e2e-"));
    onTestFinished(() => rmSync(stateDir, { recursive: true, force: true }));
    return { stateDir, env: { NO_COLOR: "1", FORCE_COLOR: "0", SMITHERS_GATEWAY_STATE_DIR: stateDir } };
}

/**
 * Spawn a long-running `smithers gateway` and wait until it is serving.
 *
 * @param {{ dir: string }} repo
 * @param {Record<string, string>} env
 * @param {string[]} [extraArgs]
 */
async function startGateway(repo, env, extraArgs = []) {
    const child = spawn(process.execPath, ["run", CLI_ENTRY, "gateway", ...extraArgs], {
        cwd: repo.dir,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const closePromise = new Promise((resolvePromise) => child.once("close", resolvePromise));
    onTestFinished(async () => {
        if (child.exitCode === null && !child.killed) {
            await stopProcess(child, closePromise);
        }
    });
    await waitFor(() => stderr.includes("Gateway listening on"), 20_000);
    return { child, closePromise, stderr: () => stderr };
}

async function findOpenPort() {
    const server = createServer();
    await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (!address || typeof address === "string") {
        throw new Error("Could not allocate an open port");
    }
    return address.port;
}

async function waitFor(predicate, timeoutMs = 10_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error("Timed out waiting for condition");
}

async function stopProcess(child, closePromise) {
    child.kill("SIGTERM");
    const closed = await Promise.race([
        closePromise.then(() => true),
        new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
    ]);
    if (!closed) {
        child.kill("SIGKILL");
        await closePromise;
    }
}

test("gateway help distinguishes the multi-run Gateway from up --serve", () => {
    const repo = createTempRepo();
    const result = runSmithers(["gateway", "--help"], {
        cwd: repo.dir,
        format: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("multi-run Gateway RPC/WS control plane");
    expect(result.stdout).toContain("unlike up --serve");
});

test("gateway starts for an initialized workspace with no existing DB and listRuns is empty", async () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
    const dbPath = repo.path("smithers.db");
    expect(existsSync(dbPath)).toBe(false);

    const port = await findOpenPort();
    const child = spawn(process.execPath, ["run", CLI_ENTRY, "gateway", "--host", "127.0.0.1", "--port", String(port)], {
        cwd: repo.dir,
        env: {
            ...process.env,
            NO_COLOR: "1",
            FORCE_COLOR: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const closePromise = new Promise((resolvePromise) => child.once("close", resolvePromise));
    try {
        await waitFor(() => stderr.includes("Registered workflows:"));
        expect(stderr).toContain(`Workspace: ${repo.dir}`);
        expect(stderr).toContain(`Database: ${dbPath}`);
        expect(stderr).toContain("Registered workflows: basic");
        expect(existsSync(dbPath)).toBe(true);

        const response = await fetch(`http://127.0.0.1:${port}/v1/rpc/listRuns`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(3_000),
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.ok).toBe(true);
        expect(body.payload).toEqual([]);
    }
    finally {
        await stopProcess(child, closePromise);
    }
    expect(stdout).toBe("");
}, 15_000);

// Security regression: the Gateway control plane (launch/cancel/inspect every
// run) was constructed with no auth, so it authenticated every request as
// role=operator scopes=["*"]. `--host` accepted 0.0.0.0 unvalidated, so
// `smithers gateway --host 0.0.0.0` exposed that full-control, unauthenticated
// plane to the network. A non-loopback bind now requires a token (or --insecure).
test("gateway refuses to bind a non-loopback host with no auth", () => {
    const repo = createTempRepo();
    // Force SMITHERS_API_KEY empty so a token in the test runner's env can't
    // satisfy the guard and leave the server actually binding (and hanging).
    const result = runSmithers(["gateway", "--host", "0.0.0.0"], {
        cwd: repo.dir,
        format: "json",
        env: { SMITHERS_API_KEY: "" },
        timeoutMs: 30_000,
    });
    expect(result.exitCode).not.toBe(0);
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).toContain("non-loopback");
    expect(all).toMatch(/auth-token|insecure/);
}, 30_000);

test("gateway refuses a routable LAN host with no auth", () => {
    const repo = createTempRepo();
    const result = runSmithers(["gateway", "--host", "192.168.1.50"], {
        cwd: repo.dir,
        format: "json",
        env: { SMITHERS_API_KEY: "" },
        timeoutMs: 30_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("non-loopback");
}, 30_000);

// Singleton lifecycle (spec: .smithers/specs/singleton-gateway.md, G1): the
// daemon records where it listens in a per-workspace runtime state file;
// `status` reports it, a second start refuses, `stop` tears it down.
test("gateway writes runtime state, enforces the singleton, and status/stop manage it", async () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
    const { stateDir, env } = makeStateDirEnv();
    const port = await findOpenPort();

    const gateway = await startGateway(repo, env, ["--port", String(port)]);
    const stateEnv = { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
    const state = readGatewayRuntimeState(repo.dir, stateEnv);
    expect(state?.port).toBe(port);
    expect(state?.pid).toBe(gateway.child.pid);
    expect(state?.token).toBeNull();
    expect(gateway.stderr()).toContain("Runtime state:");

    // /health advertises the workspace identity clients verify against.
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json());
    expect(health.identity.pid).toBe(gateway.child.pid);
    expect(existsSync(health.identity.workspaceRoot)).toBe(true);

    // Second start against a healthy incumbent refuses.
    const second = runSmithers(["gateway", "--port", String(await findOpenPort())], {
        cwd: repo.dir,
        format: "json",
        env,
        timeoutMs: 30_000,
    });
    expect(second.exitCode).not.toBe(0);
    expect(`${second.stdout}\n${second.stderr}`).toContain("already running");

    // status reports the running daemon.
    const status = runSmithers(["gateway", "status"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
    expect(status.exitCode).toBe(0);
    expect(status.json?.running).toBe(true);
    expect(status.json?.pid).toBe(gateway.child.pid);

    // stop tears it down and clears the state file.
    const stop = runSmithers(["gateway", "stop"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
    expect(stop.exitCode).toBe(0);
    expect(stop.json?.stopped).toBe(true);
    await gateway.closePromise;
    expect(readGatewayRuntimeState(repo.dir, stateEnv)).toBeNull();

    const statusAfter = runSmithers(["gateway", "status"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
    expect(statusAfter.exitCode).toBe(0);
    expect(statusAfter.json?.running).toBe(false);
}, 60_000);

// Decision 6: the preferred port being taken by ANOTHER process must not
// crash the daemon (EADDRINUSE used to surface as an unhandled 'error'
// event); it falls back to an ephemeral port recorded in the state file.
test("gateway falls back to an ephemeral port when the preferred port is taken", async () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
    const { stateDir, env } = makeStateDirEnv();

    const squatter = createServer();
    await new Promise((resolvePromise, reject) => {
        squatter.once("error", reject);
        squatter.listen(0, "127.0.0.1", resolvePromise);
    });
    const takenPort = squatter.address().port;
    onTestFinished(() => new Promise((resolvePromise) => squatter.close(resolvePromise)));

    const gateway = await startGateway(repo, env, ["--port", String(takenPort)]);
    expect(gateway.stderr()).toContain("ephemeral port");
    const stateEnv = { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
    const state = readGatewayRuntimeState(repo.dir, stateEnv);
    expect(state?.port).toBeGreaterThan(0);
    expect(state?.port).not.toBe(takenPort);
    const health = await fetch(`${state.url}/health`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(health.identity.pid).toBe(gateway.child.pid);
}, 60_000);

// --mint-token: requests without the bearer are rejected; the token lives
// only in the 0600 state file (and the daemon's own stderr).
test("gateway --mint-token requires the minted bearer", async () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
    const { stateDir, env } = makeStateDirEnv();
    const port = await findOpenPort();

    const gateway = await startGateway(repo, { ...env, SMITHERS_API_KEY: "" }, ["--port", String(port), "--mint-token"]);
    const stateEnv = { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
    const state = readGatewayRuntimeState(repo.dir, stateEnv);
    expect(state?.token).toHaveLength(64);
    expect(gateway.stderr()).toContain("Minted bearer token");

    const { stateFile } = gatewayRuntimePaths(repo.dir, stateEnv);
    expect(readFileSync(stateFile, "utf8")).toContain(state.token);

    const unauthenticated = await fetch(`${state.url}/v1/rpc/listRuns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(3_000),
    });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await fetch(`${state.url}/v1/rpc/listRuns`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
        body: "{}",
        signal: AbortSignal.timeout(3_000),
    });
    expect(authenticated.status).toBe(200);
    const body = await authenticated.json();
    expect(body.ok).toBe(true);
}, 60_000);

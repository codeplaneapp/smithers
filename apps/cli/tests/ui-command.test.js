import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

const children = new Set();

afterEach(async () => {
    await Promise.all([...children].map((entry) => stopProcess(entry.child, entry.closePromise)));
    children.clear();
});

async function findOpenPort() {
    const server = createNetServer();
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

function rpcResponse(payload) {
    return { type: "res", ok: true, payload };
}

async function startFakeGateway(handler) {
    const requests = [];
    const server = createHttpServer(async (req, res) => {
        if (req.url === "/health") {
            requests.push({ method: "health", body: null });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        const match = req.url?.match(/^\/v1\/rpc\/([^/?]+)/);
        if (!match) {
            res.writeHead(404);
            res.end();
            return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        const params = body ? JSON.parse(body) : {};
        const method = match[1];
        requests.push({ method, body: params });
        const frame = handler(method, params);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(frame));
    });
    await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Fake Gateway did not bind to a TCP port");
    }
    return {
        base: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
    };
}

async function stopProcess(child, closePromise) {
    if (child.exitCode !== null || child.signalCode) {
        await closePromise;
        return;
    }
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

async function stopGatewayOnPort(port) {
    const result = spawnSync("lsof", ["-ti", `tcp:${port}`], {
        encoding: "utf8",
    });
    const pids = (result.stdout ?? "")
        .split(/\s+/)
        .map((pid) => Number(pid))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    for (const pid of pids) {
        try {
            process.kill(pid, "SIGTERM");
        }
        catch { }
    }
    if (pids.length === 0) return;
    await waitFor(() => pids.every((pid) => {
        try {
            process.kill(pid, 0);
            return false;
        }
        catch {
            return true;
        }
    }), 2_000).catch(() => {
        for (const pid of pids) {
            try {
                process.kill(pid, "SIGKILL");
            }
            catch { }
        }
    });
}

function spawnSmithers(args, options) {
    const child = spawn(process.execPath, ["run", CLI_ENTRY, ...args], {
        cwd: options.cwd,
        env: {
            ...process.env,
            NO_COLOR: "1",
            FORCE_COLOR: "0",
            ...options.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const closePromise = new Promise((resolvePromise) => child.once("close", resolvePromise));
    children.add({ child, closePromise });
    return { child, closePromise };
}

async function runSmithersAsync(args, options) {
    const { child, closePromise } = spawnSmithers([
        ...args,
        "--format",
        options.format ?? "json",
    ], options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await closePromise;
    return {
        exitCode,
        stdout,
        stderr,
        json: options.format === null ? undefined : JSON.parse(stdout.slice(stdout.indexOf("{"))),
    };
}

async function waitFor(predicate, timeoutMs = 20_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const value = await predicate();
        if (value) return value;
        await Bun.sleep(50);
    }
    throw new Error("Timed out waiting for condition");
}

describe("smithers ui", () => {
    test("resolves the latest run to its workflow UI and prints a deep link", async () => {
        const repo = createTempRepo();
        const gateway = await startFakeGateway((method, params) => {
            if (method === "listWorkflows") {
                return rpcResponse([{ key: "alpha", hasUi: true, uiPath: "/ui/alpha" }]);
            }
            if (method === "listRuns") {
                return rpcResponse([{ runId: "run-latest", workflowKey: "alpha" }]);
            }
            throw new Error(`Unexpected RPC ${method} ${JSON.stringify(params)}`);
        });
        try {
            const result = await runSmithersAsync(["ui", "--gateway", gateway.base, "--no-open"], {
                cwd: repo.dir,
                format: "json",
            });
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(`"url": "${gateway.base}/ui/alpha?runId=run-latest"`);
            expect(result.json).toMatchObject({
                opened: false,
                url: `${gateway.base}/ui/alpha?runId=run-latest`,
                runId: "run-latest",
                workflow: "alpha",
            });
            expect(gateway.requests.map((request) => request.method)).toEqual([
                "health",
                "listWorkflows",
                "listRuns",
            ]);
        }
        finally {
            await gateway.close();
        }
    }, 30_000);

    test("resolves an explicit run through getRun before opening its workflow UI", async () => {
        const repo = createTempRepo();
        const gateway = await startFakeGateway((method, params) => {
            if (method === "listWorkflows") {
                return rpcResponse([{ key: "beta", hasUi: true, uiPath: "/ui/beta" }]);
            }
            if (method === "getRun") {
                expect(params).toEqual({ runId: "run-explicit" });
                return rpcResponse({ runId: "run-explicit", workflowKey: "beta" });
            }
            throw new Error(`Unexpected RPC ${method}`);
        });
        try {
            const result = await runSmithersAsync(["ui", "run-explicit", "--gateway", gateway.base, "--no-open"], {
                cwd: repo.dir,
                format: "json",
            });
            expect(result.exitCode).toBe(0);
            expect(result.json).toMatchObject({
                opened: false,
                url: `${gateway.base}/ui/beta?runId=run-explicit`,
                runId: "run-explicit",
                workflow: "beta",
            });
            expect(gateway.requests.map((request) => request.method)).toEqual([
                "health",
                "listWorkflows",
                "getRun",
            ]);
        }
        finally {
            await gateway.close();
        }
    }, 30_000);

    test("emits a JSON error envelope when no Gateway is reachable and autostart is disabled", async () => {
        const repo = createTempRepo();
        const port = await findOpenPort();
        const result = runSmithers(["ui", "--port", String(port), "--no-autostart"], {
            cwd: repo.dir,
            format: "json",
            timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(4);
        expect(result.stderr).toBe("");
        const envelope = result.json;
        expect(envelope).toMatchObject({
            code: "GATEWAY_UNREACHABLE",
        });
        expect(envelope.message).toContain(`http://127.0.0.1:${port}`);
    }, 30_000);

    test("autostarts a local Gateway when no Gateway is already listening", async () => {
        const repo = createTempRepo();
        writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
        repo.write(".smithers/ui/basic.tsx", [
            "import React from \"react\";",
            "",
            "export default function BasicUi() {",
            "  return <main>Basic UI</main>;",
            "}",
            "",
        ].join("\n"));
        const port = await findOpenPort();
        try {
            const { child, closePromise } = spawnSmithers([
                "ui",
                "--workflow",
                "basic",
                "--port",
                String(port),
                "--no-open",
                "--format",
                "json",
            ], { cwd: repo.dir });
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => { stdout += chunk; });
            child.stderr.on("data", (chunk) => { stderr += chunk; });
            const exitCode = await Promise.race([
                closePromise,
                waitFor(() => stdout.includes("/ui/basic")).then(() => 0),
            ]);
            expect(exitCode).toBe(0);
            expect(stderr).toContain(`No Gateway at http://127.0.0.1:${port}; starting one`);
            expect(stdout).toContain(`http://127.0.0.1:${port}/workflows/basic`);
            const envelope = JSON.parse(stdout.slice(stdout.indexOf("{")));
            expect(envelope).toMatchObject({
                opened: false,
                url: `http://127.0.0.1:${port}/workflows/basic`,
                runId: null,
                workflow: "basic",
            });
        }
        finally {
            await stopGatewayOnPort(port);
        }
    }, 45_000);
});

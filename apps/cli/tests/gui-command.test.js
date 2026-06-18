import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { createExecutableDir, createTempRepo, prependPath, runSmithers, writeExecutable } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");
const servers = new Set();
const children = new Set();

afterEach(async () => {
    await Promise.all([...children].map(({ child, closePromise }) => stopProcess(child, closePromise)));
    children.clear();
    await Promise.all([...servers].map((server) => new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
    })));
    servers.clear();
});

function rpcResponse(payload) {
    return { type: "res", ok: true, payload };
}

async function stopProcess(child, closePromise) {
    if (child.exitCode !== null || child.signalCode) {
        await closePromise;
        return;
    }
    child.kill("SIGTERM");
    await Promise.race([
        closePromise,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
}

function parseEnvelope(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) {
        throw new Error(`Expected a JSON envelope on stdout but got nothing. stdout=${JSON.stringify(stdout)}`);
    }
    const lastObjectStart = trimmed.lastIndexOf("\n{");
    return JSON.parse(lastObjectStart >= 0 ? trimmed.slice(lastObjectStart + 1) : trimmed);
}

async function runSmithersAsync(args, options) {
    const child = spawn(process.execPath, ["run", CLI_ENTRY, ...args, "--format", options.format ?? "json"], {
        cwd: options.cwd,
        env: {
            ...process.env,
            NO_COLOR: "1",
            FORCE_COLOR: "0",
            ...options.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const closePromise = new Promise((resolve) => child.once("close", resolve));
    children.add({ child, closePromise });
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
        json: parseEnvelope(stdout),
    };
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
        const method = match[1];
        const params = body ? JSON.parse(body) : {};
        requests.push({ method, body: params });
        const frame = handler(method, params);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(frame));
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    servers.add(server);
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Fake Gateway did not bind to a TCP port");
    }
    return {
        base: `http://127.0.0.1:${address.port}`,
        requests,
    };
}

test("gui opens the requested workspace through the Gateway UI surface", async () => {
    const repo = createTempRepo();
    repo.write("workspace/.gitkeep", "\n");
    const binDir = createExecutableDir();
    writeExecutable(binDir, "open", [
        "#!/usr/bin/env node",
        'if (process.argv.includes("-b")) process.exit(70);',
        "process.exit(0);",
        "",
    ].join("\n"));
    const gateway = await startFakeGateway((method, params) => {
        if (method === "listWorkflows") {
            return rpcResponse([{ key: "alpha", hasUi: true, uiPath: "/ui/alpha" }]);
        }
        if (method === "listRuns") {
            return rpcResponse([{ runId: "run-latest", workflowKey: "alpha" }]);
        }
        throw new Error(`Unexpected RPC ${method} ${JSON.stringify(params)}`);
    });

    const result = await runSmithersAsync(["gui", "workspace", "--gateway", gateway.base, "--no-open"], {
        cwd: repo.dir,
        format: "json",
        env: prependPath(binDir),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${gateway.base}/ui/alpha?runId=run-latest`);
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
}, 30_000);

test("bare directory shortcut opens through the Gateway UI surface", async () => {
    const repo = createTempRepo();
    repo.write("workspace/.gitkeep", "\n");
    const gateway = await startFakeGateway((method, params) => {
        if (method === "listWorkflows") {
            return rpcResponse([{ key: "alpha", hasUi: true, uiPath: "/ui/alpha" }]);
        }
        if (method === "listRuns") {
            return rpcResponse([{ runId: "run-latest", workflowKey: "alpha" }]);
        }
        throw new Error(`Unexpected RPC ${method} ${JSON.stringify(params)}`);
    });

    const result = await runSmithersAsync(["workspace", "--gateway", gateway.base, "--no-open"], {
        cwd: repo.dir,
        format: "json",
    });

    expect(result.exitCode).toBe(0);
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
}, 30_000);

test("gui preserves directory validation before opening the Gateway UI", () => {
    const repo = createTempRepo();

    const result = runSmithers(["gui", "missing", "--no-autostart"], {
        cwd: repo.dir,
        format: "json",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
        code: "PATH_NOT_FOUND",
    });
});

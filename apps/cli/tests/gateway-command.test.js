import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

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

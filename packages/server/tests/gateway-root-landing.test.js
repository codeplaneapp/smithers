import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { jsx, jsxs } from "smithers-orchestrator/jsx-runtime";
import { Gateway } from "../src/gateway.js";

function getPort(server) {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    return addr.port;
}

function createValueWorkflow(dbPath) {
    const { smithers, Workflow, Task, outputs } = createSmithers(
        { result: z.object({ ok: z.boolean() }) },
        { dbPath },
    );
    return smithers(() => jsxs(Workflow, {
        name: "gateway-root-landing-test",
        children: [
            jsx(Task, {
                id: "task1",
                output: outputs.result,
                children: { ok: true },
            }),
        ],
    }));
}

function writeUiEntry(dir, label) {
    const entry = join(dir, "ui.jsx");
    writeFileSync(
        entry,
        [
            'import { createElement } from "react";',
            'import { createRoot } from "react-dom/client";',
            `createRoot(document.getElementById("root")).render(createElement("main", null, ${JSON.stringify(label)}));`,
        ].join("\n"),
    );
    return entry;
}

describe("gateway root landing", () => {
    let gateway;
    let server;
    let port;
    let tempDir;

    async function startGateway(options) {
        gateway = new Gateway(options);
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        port = getPort(server);
    }

    afterEach(async () => {
        if (gateway) await gateway.close();
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
        gateway = undefined;
        server = undefined;
        port = undefined;
        tempDir = undefined;
    });

    test("GET / redirects to the default operator console", async () => {
        await startGateway();

        const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console");
        expect(res.headers.get("x-smithers-api-version")).toBeTruthy();
    });

    test("GET / with a query string still redirects to the operator console", async () => {
        await startGateway();

        const res = await fetch(`http://127.0.0.1:${port}/?from=browser`, { redirect: "manual" });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console");
    });

    test("GET / renders a discovery page when no UI is mounted", async () => {
        await startGateway({ operatorUi: false });

        const res = await fetch(`http://127.0.0.1:${port}/`);

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        const body = await res.text();
        expect(body).toContain("No UI mounted");
        expect(body).toContain('href="/health"');
        expect(body).toContain('href="/metrics"');
        expect(body).toContain('href="/workflows"');
    });

    test("GET / renders registered workflow UI links when the operator console is disabled", async () => {
        tempDir = mkdtempSync(join(process.cwd(), ".smithers-root-landing-ui-"));
        const entry = writeUiEntry(tempDir, "Deploy UI");
        await startGateway({ operatorUi: false });
        gateway.register("deploy", createValueWorkflow(join(tempDir, "workflow.db")), {
            ui: {
                entry,
                title: "Deploy Workflow",
            },
        });

        const res = await fetch(`http://127.0.0.1:${port}/`);

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        const body = await res.text();
        expect(body).toContain("Workflow UIs are mounted below.");
        expect(body).toContain('href="/workflows/deploy"');
        expect(body).toContain("Deploy Workflow");
    });

    test("existing gateway routes still respond as before", async () => {
        await startGateway();

        const consoleRes = await fetch(`http://127.0.0.1:${port}/console`);
        expect(consoleRes.status).toBe(200);

        const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
        expect(healthRes.status).toBe(200);
        expect(await healthRes.json()).toMatchObject({ ok: true });

        const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
        expect(metricsRes.status).toBe(200);
        expect(metricsRes.headers.get("content-type")).toContain("text/plain");

        const workflowsRes = await fetch(`http://127.0.0.1:${port}/workflows`);
        expect(workflowsRes.status).toBe(200);
        expect(await workflowsRes.json()).toMatchObject({ workflows: [] });
    });
});

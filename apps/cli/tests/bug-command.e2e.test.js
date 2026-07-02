import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_COMMAND_TIMEOUT_MS = 120_000;
const FIXTURE_SERVER = resolve(import.meta.dir, "bug-endpoint-server.js");

/**
 * Real local bug endpoint (no mocks): bug-endpoint-server.js implements the
 * bug.smithers.sh worker contract (`POST /api/bugs` -> `{ id, url }`) in its
 * own process and appends each received payload to a JSONL log file.
 */
let serverChild;
let serverPort;
let payloadLogFile;
/** Port that had a listener and no longer does — a reliably refused endpoint. */
let deadPort;

beforeAll(async () => {
    payloadLogFile = join(mkdtempSync(join(tmpdir(), "smithers-bug-test-")), "payloads.jsonl");
    serverChild = Bun.spawn([process.execPath, FIXTURE_SERVER, payloadLogFile], {
        stdout: "pipe",
        stderr: "inherit",
    });
    const reader = serverChild.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    serverPort = JSON.parse(new TextDecoder().decode(value)).port;
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    deadPort = probe.port;
    probe.stop(true);
});

afterAll(() => {
    serverChild?.kill();
});

function liveEndpoint() {
    return `http://127.0.0.1:${serverPort}/api/bugs`;
}

function receivedPayloadsSnapshot() {
    if (!existsSync(payloadLogFile)) return [];
    return readFileSync(payloadLogFile, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
}

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
    pinSqliteBackend(repo.dir);
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { sqlite, adapter: new SmithersDb(db) };
}

/**
 * Seed a failed run with an error and event history containing
 * deliberately secret-looking material that the command must scrub.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} eventCount
 */
async function seedFailedRun(adapter, runId, eventCount) {
    const now = Date.now();
    await adapter.insertRun({
        runId,
        workflowName: "bug-fixture",
        workflowPath: "workflow.tsx",
        status: "failed",
        createdAtMs: now - 60_000,
        startedAtMs: now - 59_000,
        finishedAtMs: now - 1_000,
        heartbeatAtMs: now - 1_000,
        errorJson: JSON.stringify({
            message: "agent crashed: OPENAI_API_KEY=sk-verysecret1234567890 rejected (header was 'Authorization: Bearer topsecrettoken123')",
        }),
    });
    for (let i = 1; i <= eventCount; i += 1) {
        await adapter.insertEventWithNextSeq({
            runId,
            timestampMs: now - 60_000 + i * 100,
            type: i === eventCount ? "RunFailed" : "NodeOutput",
            payloadJson: JSON.stringify({
                nodeId: "task",
                index: i,
                apiKey: "raw-secret-value-in-key-field",
                text: `attempt ${i} used ANTHROPIC_API_KEY=sk-ant-abcdef0123456789`,
            }),
        });
    }
}

describe("smithers bug", () => {
    test("files a report with run status, error, and the last ~50 scrubbed events; exits 0", async () => {
        const repo = createTempRepo();
        const { sqlite, adapter } = openRepoDb(repo);
        try {
            await seedFailedRun(adapter, "bug-run", 60);
            const before = receivedPayloadsSnapshot().length;

            const result = runSmithers(
                ["bug", "--run", "bug-run", "--body", "It crashed on me", "--endpoint", liveEndpoint()],
                { cwd: repo.dir, format: "json", timeoutMs: CLI_COMMAND_TIMEOUT_MS },
            );

            expect(result.exitCode).toBe(0);
            expect(result.json).toMatchObject({ url: expect.stringContaining("bug.smithers.sh/b/") });
            const payloads = receivedPayloadsSnapshot();
            expect(payloads.length).toBe(before + 1);

            const payload = payloads[payloads.length - 1];
            // Payload shape.
            expect(payload.title).toContain("Run bug-run failed:");
            expect(payload.body).toBe("It crashed on me");
            expect(typeof payload.smithersVersion).toBe("string");
            expect(payload.platform).toMatchObject({ os: process.platform, arch: process.arch });
            expect(payload.run).toMatchObject({
                runId: "bug-run",
                workflowName: "bug-fixture",
                status: "failed",
            });
            // Last ~50 events only, ending with the terminal event.
            expect(payload.run.events.length).toBe(50);
            expect(payload.run.events[payload.run.events.length - 1].type).toBe("RunFailed");
            expect(payload.run.events[0].payload.index).toBe(11);

            // Secret scrubbing: none of the seeded secrets may survive anywhere.
            const wire = JSON.stringify(payload);
            expect(wire).not.toContain("sk-verysecret1234567890");
            expect(wire).not.toContain("sk-ant-abcdef0123456789");
            expect(wire).not.toContain("topsecrettoken123");
            expect(wire).not.toContain("raw-secret-value-in-key-field");
            expect(wire).toContain("[REDACTED]");
        }
        finally {
            sqlite.close();
        }
    }, CLI_COMMAND_TIMEOUT_MS);

    test("SMITHERS_BUG_ENDPOINT env var takes precedence over --endpoint", async () => {
        const repo = createTempRepo();
        pinSqliteBackend(repo.dir);
        const before = receivedPayloadsSnapshot().length;

        const result = runSmithers(
            ["bug", "--title", "env wins", "--body", "b", "--endpoint", `http://127.0.0.1:${deadPort}/api/bugs`],
            {
                cwd: repo.dir,
                format: "json",
                timeoutMs: CLI_COMMAND_TIMEOUT_MS,
                env: { SMITHERS_BUG_ENDPOINT: liveEndpoint() },
            },
        );

        expect(result.exitCode).toBe(0);
        const payloads = receivedPayloadsSnapshot();
        expect(payloads.length).toBe(before + 1);
        expect(payloads[payloads.length - 1].title).toBe("env wins");
    }, CLI_COMMAND_TIMEOUT_MS);

    test("when the endpoint is down, saves the payload to .smithers/bug-reports and exits non-zero", async () => {
        const repo = createTempRepo();
        pinSqliteBackend(repo.dir);

        const result = runSmithers(
            ["bug", "--title", "offline report", "--body", "saved for later", "--endpoint", `http://127.0.0.1:${deadPort}/api/bugs`],
            { cwd: repo.dir, format: "json", timeoutMs: CLI_COMMAND_TIMEOUT_MS },
        );

        expect(result.exitCode).not.toBe(0);
        const reportsDir = join(repo.dir, ".smithers", "bug-reports");
        expect(existsSync(reportsDir)).toBe(true);
        const files = readdirSync(reportsDir).filter((name) => name.endsWith(".json"));
        expect(files.length).toBe(1);
        const saved = JSON.parse(readFileSync(join(reportsDir, files[0]), "utf8"));
        expect(saved.title).toBe("offline report");
        expect(saved.body).toBe("saved for later");
        // The failure output points the user at the saved payload.
        expect(`${result.stdout}${result.stderr}`).toContain("bug-reports");
    }, CLI_COMMAND_TIMEOUT_MS);

    test("refuses politely with neither a run nor a title/body", async () => {
        const repo = createTempRepo();
        pinSqliteBackend(repo.dir);

        const result = runSmithers(["bug"], {
            cwd: repo.dir,
            format: "json",
            timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        });

        expect(result.exitCode).toBe(4);
        expect(`${result.stdout}${result.stderr}`).toContain("Nothing to report");
    }, CLI_COMMAND_TIMEOUT_MS);

    test("fails with RUN_NOT_FOUND when --run does not exist and no title/body is given", async () => {
        const repo = createTempRepo();
        const { sqlite } = openRepoDb(repo);
        try {
            const result = runSmithers(
                ["bug", "--run", "no-such-run", "--endpoint", liveEndpoint()],
                { cwd: repo.dir, format: "json", timeoutMs: CLI_COMMAND_TIMEOUT_MS },
            );

            expect(result.exitCode).toBe(4);
            expect(`${result.stdout}${result.stderr}`).toContain("Run not found");
        }
        finally {
            sqlite.close();
        }
    }, CLI_COMMAND_TIMEOUT_MS);
});

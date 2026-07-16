import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHindsightMemoryStore } from "../src/HindsightMemoryStore.js";

const HINDSIGHT_IMAGE = process.env.HINDSIGHT_DOCKER_IMAGE
    ?? "ghcr.io/vectorize-io/hindsight:0.8.4-slim";
const EMBEDDINGS_IMAGE = process.env.HINDSIGHT_DOCKER_EMBEDDINGS_IMAGE
    ?? "oven/bun:1.3.13";
const POSTGRES_IMAGE = process.env.HINDSIGHT_DOCKER_POSTGRES_IMAGE
    ?? "pgvector/pgvector:0.8.1-pg16";
const docker = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
const dockerAvailable = docker.exitCode === 0;
const suffix = crypto.randomUUID().slice(0, 12);
const networkName = `smithers-hindsight-test-${suffix}`;
const embeddingsName = `smithers-hindsight-embeddings-${suffix}`;
const postgresName = `smithers-hindsight-postgres-${suffix}`;
const hindsightName = `smithers-hindsight-api-${suffix}`;
let integrationUrl = "";

if (!dockerAvailable) {
    console.warn("SKIP Hindsight Docker integration: docker is unavailable");
}

/** @param {string[]} args @param {boolean} [allowFailure] */
async function runDocker(args, allowFailure = false) {
    const subprocess = Bun.spawn(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
    ]);
    if (!allowFailure && exitCode !== 0) {
        throw new Error(`docker ${args[0]} failed with exit ${exitCode}: ${stderr.trim()}`);
    }
    return stdout.trim();
}

async function cleanupDockerFixture() {
    await runDocker(["rm", "-f", hindsightName, embeddingsName, postgresName], true);
    await runDocker(["network", "rm", networkName], true);
}

function reserveLoopbackPort() {
    const probe = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("reserved"),
    });
    const port = probe.port;
    probe.stop(true);
    return port;
}

const embeddingsServer = String.raw`
const vector = [1, 0, 0, 0, 0, 0, 0, 0];
Bun.serve({
    hostname: "0.0.0.0",
    port: 8080,
    async fetch(request) {
        const url = new URL(request.url);
        if (!url.pathname.endsWith("/embeddings")) {
            return Response.json({ ok: true });
        }
        const body = await request.json();
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return Response.json({
            object: "list",
            data: inputs.map((_, index) => ({ object: "embedding", embedding: vector, index })),
            model: body.model ?? "smithers-test-embedding",
            usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        });
    },
});
await new Promise(() => {});
`;

beforeAll(async () => {
    if (!dockerAvailable) {
        return;
    }
    await cleanupDockerFixture();
    try {
        await runDocker(["network", "create", networkName]);
        await runDocker([
            "run", "-d",
            "--name", embeddingsName,
            "--network", networkName,
            "--network-alias", "embeddings",
            EMBEDDINGS_IMAGE,
            "bun", "-e", embeddingsServer,
        ]);
        await runDocker([
            "run", "-d",
            "--name", postgresName,
            "--network", networkName,
            "--network-alias", "postgres",
            "-e", "POSTGRES_USER=hindsight",
            "-e", "POSTGRES_PASSWORD=hindsight",
            "-e", "POSTGRES_DB=hindsight",
            POSTGRES_IMAGE,
        ]);
        const postgresDeadline = Date.now() + 60_000;
        let postgresReady = false;
        while (Date.now() < postgresDeadline) {
            try {
                await runDocker([
                    "exec", postgresName,
                    "pg_isready", "-U", "hindsight", "-d", "hindsight",
                ]);
                postgresReady = true;
                break;
            }
            catch {
                // Postgres is still initializing.
            }
            await Bun.sleep(500);
        }
        if (!postgresReady) {
            const logs = await runDocker(["logs", "--tail", "120", postgresName], true);
            throw new Error(`Postgres did not become ready within 60 seconds.\n${logs}`);
        }
        const port = reserveLoopbackPort();
        await runDocker([
            "run", "-d",
            "--name", hindsightName,
            "--network", networkName,
            "-p", `127.0.0.1:${port}:8888`,
            "-e", "HINDSIGHT_API_LOG_LEVEL=info",
            "-e", "HINDSIGHT_API_DATABASE_URL=postgresql://hindsight:hindsight@postgres:5432/hindsight",
            "-e", "HINDSIGHT_API_LLM_PROVIDER=none",
            "-e", "HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false",
            "-e", "HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai",
            "-e", "HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=smithers-test-key",
            "-e", "HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL=http://embeddings:8080/v1",
            "-e", "HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=smithers-test-embedding",
            "-e", "HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS=8",
            "-e", "HINDSIGHT_API_RERANKER_PROVIDER=rrf",
            HINDSIGHT_IMAGE,
        ]);
        integrationUrl = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + 360_000;
        while (Date.now() < deadline) {
            try {
                const response = await fetch(`${integrationUrl}/health`);
                if (response.ok) {
                    return;
                }
            }
            catch {
                // The API port opens only after Hindsight migrations finish.
            }
            await Bun.sleep(1_000);
        }
        const logs = await runDocker(["logs", "--tail", "160", hindsightName], true);
        throw new Error(`Hindsight did not become healthy within 360 seconds.\n${logs}`);
    }
    catch (error) {
        await cleanupDockerFixture();
        throw error;
    }
}, 480_000);

afterAll(async () => {
    if (dockerAvailable) {
        await cleanupDockerFixture();
    }
}, 60_000);

describe.skipIf(!dockerAvailable)("Hindsight Docker integration", () => {
    test("verifies append, listing, missing primers, tag validation, and scoped recall", async () => {
        const prefix = `smithers-integration-${crypto.randomUUID()}-`;
        const bank = "project-test";
        const store = createHindsightMemoryStore({
            baseUrl: integrationUrl,
            bankPrefix: prefix,
        });

        await store.retainMemory({
            bank,
            content: "The integration sentinel starts cobalt.",
            documentId: "smithers-integration-sentinel",
            updateMode: "replace",
            async: false,
            tags: ["scope:main", "branch:main"],
            metadata: { session: "integration", run: "integration" },
        });
        await store.retainMemory({
            bank,
            content: "The integration sentinel then becomes amber.",
            documentId: "smithers-integration-sentinel",
            updateMode: "append",
            async: false,
            tags: ["scope:main", "branch:main"],
            metadata: { session: "integration", run: "integration" },
        });
        await store.retainMemory({
            bank,
            content: "The integration sentinel on the secret branch is crimson.",
            documentId: "smithers-integration-secret",
            updateMode: "replace",
            async: false,
            tags: ["scope:branch", "branch:secret"],
            metadata: { session: "integration-secret", run: "integration-secret" },
        });

        const resolvedBank = store.resolveBank(bank);
        const documents = await store.listDocuments(resolvedBank);
        expect(documents).toHaveLength(2);
        const appended = documents.find((document) => document.id === "smithers-integration-sentinel");
        expect(appended.original_text).toContain("starts cobalt");
        expect(appended.original_text).toContain("becomes amber");

        await expect(store.getPrimers({
            banks: [bank],
            primerIds: ["missing-primer"],
        })).resolves.toEqual([]);

        await expect(store.client.recall(resolvedBank, "integration sentinel", {
            tags: ["scope:main"],
            tagGroups: [{ tags: ["branch:main"], match: "all_strict" }],
        })).rejects.toMatchObject({ statusCode: 422 });

        const results = await store.recallMemory({
            banks: [bank],
            query: "integration sentinel",
            budget: "low",
            maxTokens: 512,
            tagGroupsByBank: {
                [bank]: [{
                    or: [
                        { tags: ["scope:main"], match: "all_strict" },
                        { tags: ["branch:feature"], match: "all_strict" },
                    ],
                }],
            },
        });
        expect(results.some((result) => result.text.includes("cobalt") || result.text.includes("amber"))).toBe(true);
        expect(results.some((result) => result.text.includes("crimson"))).toBe(false);
    }, 60_000);
});

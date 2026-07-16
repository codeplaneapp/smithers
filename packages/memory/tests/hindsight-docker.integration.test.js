import { describe, expect, test } from "bun:test";
import { createHindsightMemoryStore } from "../src/HindsightMemoryStore.js";

const docker = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
const integrationUrl = process.env.HINDSIGHT_DOCKER_TEST_URL;
const skipReason = docker.exitCode !== 0
    ? "docker is unavailable"
    : !integrationUrl
        ? "HINDSIGHT_DOCKER_TEST_URL is unset (no opt-in Hindsight container)"
        : "";

if (skipReason) {
    console.warn(`SKIP Hindsight Docker integration: ${skipReason}`);
}

describe.skipIf(Boolean(skipReason))("Hindsight Docker integration", () => {
    test("retains and recalls against the configured local container", async () => {
        const store = createHindsightMemoryStore({
            baseUrl: integrationUrl,
            apiKey: process.env.HINDSIGHT_DOCKER_TEST_API_KEY,
            bankPrefix: `smithers-integration-${crypto.randomUUID()}-`,
        });
        const bank = "project-test";
        await store.retainMemory({
            bank,
            content: "The Smithers Hindsight integration sentinel is cobalt.",
            documentId: "smithers-integration-sentinel",
            updateMode: "replace",
            async: false,
            tags: ["scope:main", "source:run"],
            metadata: { session: "integration", run: "integration" },
        });
        const results = await store.recallMemory({
            banks: [bank],
            query: "What color is the integration sentinel?",
            tags: ["scope:main", "source:run"],
            budget: "low",
            maxTokens: 256,
        });
        expect(results.some((result) => result.text.toLowerCase().includes("cobalt"))).toBe(true);
    }, 60_000);
});

import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

test("smithers usage prints a table to stderr and JSON reports to stdout", () => {
    const repo = createTempRepo();
    const smithersHome = repo.path(".smithers-home");
    mkdirSync(smithersHome, { recursive: true });
    writeFileSync(join(smithersHome, "accounts.json"), JSON.stringify({
        version: 1,
        accounts: [
            {
                label: "kimi-main",
                provider: "kimi",
                configDir: "/tmp/kimi-main",
                addedAt: "2026-06-03T00:00:00.000Z",
            },
            {
                label: "openai-main",
                provider: "openai-api",
                apiKey: "",
                addedAt: "2026-06-03T00:00:00.000Z",
            },
        ],
    }, null, 2));

    const result = runSmithers(["usage", "--account", "kimi-main"], {
        cwd: repo.dir,
        format: "json",
        env: { SMITHERS_HOME: smithersHome },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("ACCOUNT");
    expect(result.stderr).toContain("kimi-main");
    expect(result.stderr).toContain("Kimi exposes no usage endpoint yet");
    expect(result.stdout).toContain("\"reports\"");
    expect(result.json?.reports).toMatchObject([
        {
            accountLabel: "kimi-main",
            provider: "kimi",
            source: "none",
            error: "Kimi exposes no usage endpoint yet",
        },
    ]);
}, 30_000);

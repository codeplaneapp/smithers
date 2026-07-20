import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import {
    createTempRepo,
    runSmithers,
} from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function seedDb(repo) {
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    sqlite.close();
}

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function readHumanRequests(repo) {
    const sqlite = new Database(repo.path("smithers.db"));
    try {
        return sqlite
            .query(
                "SELECT request_id, run_id, status, kind, prompt FROM _smithers_human_requests",
            )
            .all();
    } finally {
        sqlite.close();
    }
}

describe("smithers ask-human", () => {
    test("creates a durable request and exits 3 when it expires before a human responds", () => {
        const repo = createTempRepo();
        seedDb(repo);

        const result = runSmithers(
            [
                "ask-human",
                "Approve the prod deploy?",
                "--run-id",
                "run-x",
                "--timeout",
                "0.001",
                "--poll",
                "0.25",
            ],
            { cwd: repo.dir, format: "json", timeoutMs: 30_000 },
        );

        // NOTE: under `bun test`, a nested spawnSync child's stdout/stderr come back
        // empty when the child calls process.exit(non-zero) (a bun-test stdio-flush
        // quirk — real shells/agents do receive the output). So we assert on the exit
        // code and the durable request row, not captured output. The operator banner
        // text is covered by ask-human-unit.test.js (formatAskHumanResolveHelp).
        expect(result.exitCode).toBe(3);

        const rows = readHumanRequests(repo);
        expect(rows).toHaveLength(1);
        expect(rows[0].run_id).toBe("run-x");
        expect(rows[0].status).toBe("expired");
        expect(rows[0].kind).toBe("ask");
        expect(String(rows[0].prompt)).toContain("Approve the prod deploy?");
    });

    test("rejects an empty prompt", () => {
        const repo = createTempRepo();
        seedDb(repo);

        const result = runSmithers(["ask-human", "   "], {
            cwd: repo.dir,
            format: "json",
            timeoutMs: 30_000,
        });

        expect(result.exitCode).toBe(4);
    });
});

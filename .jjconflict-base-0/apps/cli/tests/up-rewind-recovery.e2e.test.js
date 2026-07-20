// H10 regression: jumpToFrame writes a durable `in_progress` rewind-audit marker
// before mutating, so a crash mid-rewind can be recovered on startup — but
// recoverInProgressRewindAudits was exported and tested yet NEVER invoked at
// boot, so the marker was dead weight and the run stayed un-recovered. The CLI
// `up` command now runs the recovery at startup. This proves it end to end: a
// seeded `in_progress` audit is flipped to `partial` by running `smithers up`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { writeRewindAuditRow } from "@smithers-orchestrator/time-travel/writeRewindAuditRow";
import { listRewindAuditRows } from "@smithers-orchestrator/time-travel/listRewindAuditRows";
import {
    createTempRepo,
    pinSqliteBackend,
    runSmithers,
    writeTestWorkflow,
} from "../../../packages/smithers/tests/e2e-helpers.js";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const E2E_DEPS_AVAILABLE =
    existsSync(join(REPO_ROOT, "node_modules", "zod")) &&
    existsSync(join(REPO_ROOT, "node_modules", "react"));
const testIfDeps = E2E_DEPS_AVAILABLE ? test : test.skip;

testIfDeps(
    "smithers up recovers a crash-interrupted rewind audit at startup",
    async () => {
        const repo = createTempRepo();
        pinSqliteBackend(repo.dir);

        // Seed a prior run whose rewind crashed mid-flight: an in_progress audit row.
        {
            const sqlite = new Database(repo.path("smithers.db"));
            const db = drizzle(sqlite);
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            await adapter.insertRun({ runId: "crashed-rewind", workflowName: "wf", status: "running", createdAtMs: 1 });
            await writeRewindAuditRow(adapter, {
                runId: "crashed-rewind",
                fromFrameNo: 5,
                toFrameNo: 2,
                caller: "user:test",
                timestampMs: 1_000,
                result: "in_progress",
                durationMs: null,
            });
            sqlite.close();
        }

        writeTestWorkflow(repo);
        // Recovery runs at startup (before the run is driven), so the audit must be
        // flipped to "partial" regardless of the run's own outcome.
        runSmithers(["up", "workflow.tsx"], { cwd: repo.dir, format: "json", timeoutMs: 45_000 });

        const sqlite = new Database(repo.path("smithers.db"));
        const adapter = new SmithersDb(drizzle(sqlite));
        const audits = await listRewindAuditRows(adapter, { runId: "crashed-rewind" });
        sqlite.close();
        expect(audits[0]?.result).toBe("partial");
    },
    60_000,
);

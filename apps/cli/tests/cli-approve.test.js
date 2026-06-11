import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import {
    createTempRepo,
    runSmithers,
} from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 * @param {string} runId
 * @param {string} nodeId
 * @param {object} requestPayload
 * @param {object} [options]
 * @param {number} [options.iteration]
 * @param {string} [options.note]
 */
function seedApprovalGate(repo, runId, nodeId, requestPayload, options = {}) {
    const sqlite = new Database(repo.path("smithers.db"));
    try {
        ensureSmithersTables(sqlite);
        
        // Insert a run
        sqlite.prepare(`
            INSERT INTO runs (runId, workflowPath, workflowHash, status, createdAtMs)
            VALUES (?, ?, ?, ?, ?)
        `).run(runId, "test.ts", "hash1", "waiting-approval", Date.now());
        
        // Insert an approval gate
        const requestJson = requestPayload ? JSON.stringify(requestPayload) : null;
        sqlite.prepare(`
            INSERT INTO approvals (runId, nodeId, iteration, status, requestedAtMs, requestJson, note)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            runId,
            nodeId,
            options.iteration ?? 0,
            "pending",
            Date.now(),
            requestJson,
            options.note ?? null
        );
    } finally {
        sqlite.close();
    }
}

/**
 * Insert multiple approval gates for the same run
 */
function seedMultipleApprovals(repo, runId) {
    const sqlite = new Database(repo.path("smithers.db"));
    try {
        ensureSmithersTables(sqlite);
        
        sqlite.prepare(`
            INSERT INTO runs (runId, workflowPath, workflowHash, status, createdAtMs)
            VALUES (?, ?, ?, ?, ?)
        `).run(runId, "test.ts", "hash1", "waiting-approval", Date.now());
        
        // Insert two approval gates
        for (let i = 0; i < 2; i++) {
            const requestJson = JSON.stringify({ title: `Request ${i + 1}` });
            sqlite.prepare(`
                INSERT INTO approvals (runId, nodeId, iteration, status, requestedAtMs, requestJson)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(runId, `node-${i}`, 0, "pending", Date.now(), requestJson);
        }
    } finally {
        sqlite.close();
    }
}

describe("smithers approve/deny commands", () => {
    test("approve command renders request and succeeds with --yes", () => {
        const repo = createTempRepo();
        const runId = "test-run-approve";
        const nodeId = "approval-node";
        seedApprovalGate(repo, runId, nodeId, {
            title: "Deploy to production",
            message: "Ready to deploy version 1.0.0",
        });

        const result = runSmithers(
            ["approve", runId, "--node", nodeId, "--yes"],
            { cwd: repo.dir, format: "json" },
        );

        expect(result.exitCode).toBe(0);
        expect(result.json).toBeDefined();
        expect(result.json.status).toBe("approved");
        expect(result.json.nodeId).toBe(nodeId);
        expect(result.json.pendingApproval).toBeDefined();
        expect(result.json.pendingApproval.request.title).toBe("Deploy to production");
    });

    test("approve command requires --yes in non-TTY context", () => {
        const repo = createTempRepo();
        const runId = "test-run-no-yes";
        const nodeId = "approval-node";
        seedApprovalGate(repo, runId, nodeId, {
            title: "Approve migration",
            message: "This cannot be undone",
        });

        const result = runSmithers(
            ["approve", runId, "--node", nodeId],
            { cwd: repo.dir, format: "json" },
        );

        expect(result.exitCode).toBe(3);
        expect(result.stderr).toContain("CONFIRMATION_REQUIRED");
    });

    test("deny command works symmetrically with approve", () => {
        const repo = createTempRepo();
        const runId = "test-run-deny";
        const nodeId = "approval-node";
        seedApprovalGate(repo, runId, nodeId, {
            title: "Dangerous operation",
            message: "Are you sure?",
        });

        const result = runSmithers(
            ["deny", runId, "--node", nodeId, "--yes"],
            { cwd: repo.dir, format: "json" },
        );

        expect(result.exitCode).toBe(0);
        expect(result.json.status).toBe("denied");
        expect(result.json.nodeId).toBe(nodeId);
        expect(result.json.pendingApproval).toBeDefined();
        expect(result.json.pendingApproval.request.title).toBe("Dangerous operation");
    });

    test("deny command requires --yes in non-TTY context", () => {
        const repo = createTempRepo();
        const runId = "test-run-deny-no-yes";
        const nodeId = "approval-node";
        seedApprovalGate(repo, runId, nodeId, {
            title: "Deny operation",
            message: "This will stop the workflow",
        });

        const result = runSmithers(
            ["deny", runId, "--node", nodeId],
            { cwd: repo.dir, format: "json" },
        );

        expect(result.exitCode).toBe(3);
        expect(result.stderr).toContain("CONFIRMATION_REQUIRED");
    });

    test("approve fails with ambiguous multiple approvals", () => {
        const repo = createTempRepo();
        const runId = "test-run-ambiguous";
        seedMultipleApprovals(repo, runId);

        const result = runSmithers(
            ["approve", runId, "--yes"],
            { cwd: repo.dir, format: "json" },
        );

        expect(result.exitCode).toBe(4);
        expect(result.stderr).toContain("AMBIGUOUS_APPROVAL");
    });

    test("approve auto-detects single pending approval", () => {
        const repo = createTempRepo();
        const runId = "test-run-auto-detect";
        const nodeId = "only-approval";
        seedApprovalGate(repo, runId, nodeId, {
            title: "Auto-detected approval",
        });

        const result = runSmithers(
            ["approve", runId, "--yes"],
            { cwd: repo.dir, format: "json" },
        );

        expect(result.exitCode).toBe(0);
        expect(result.json.nodeId).toBe(nodeId);
    });

    test("approve fails when no pending approvals exist", () => {
        const repo = createTempRepo();
        const runId = "test-run-empty";

        // Create run but no approvals
        const sqlite = new Database(repo.path("smithers.db"));
        ensureSmithersTables(sqlite);
        sqlite.prepare(`
            INSERT INTO runs (runId, workflowPath, workflowHash, status, createdAtMs)
            VALUES (?, ?, ?, ?, ?)
        `).run(runId, "test.ts", "hash1", "idle", Date.now());
        sqlite.close();

        const result = runSmithers(
            ["approve", runId, "--yes"],
            { cwd: repo.dir, format: "json" },
        );

        expect(result.exitCode).toBe(4);
        expect(result.stderr).toContain("NO_PENDING_APPROVALS");
    });

    test("approve includes malformed request gracefully", () => {
        const repo = createTempRepo();
        const runId = "test-run-malformed";
        const nodeId = "approval-node";

        // Manually insert with malformed JSON
        const sqlite = new Database(repo.path("smithers.db"));
        ensureSmithersTables(sqlite);
        sqlite.prepare(`
            INSERT INTO runs (runId, workflowPath, workflowHash, status, createdAtMs)
            VALUES (?, ?, ?, ?, ?)
        `).run(runId, "test.ts", "hash1", "waiting-approval", Date.now());
        sqlite.prepare(`
            INSERT INTO approvals (runId, nodeId, iteration, status, requestedAtMs, requestJson)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(runId, nodeId, 0, "pending", Date.now(), "{ invalid json ");
        sqlite.close();

        const result = runSmithers(
            ["approve", runId, "--node", nodeId, "--yes"],
            { cwd: repo.dir, format: "json" },
        );

        expect(result.exitCode).toBe(0);
        // Should succeed despite malformed JSON, with null request
        expect(result.json.pendingApproval.request).toBeNull();
    });

    test("approve includes complex request structures in output", () => {
        const repo = createTempRepo();
        const runId = "test-run-complex";
        const nodeId = "approval-node";
        
        seedApprovalGate(repo, runId, nodeId, {
            title: "Permission request",
            message: "Grant access to resources",
            requestedScopes: ["read:data", "write:config"],
            options: [
                { label: "Read-only", value: "read" },
                { label: "Full access", value: "admin" },
            ],
        });

        const result = runSmithers(
            ["approve", runId, "--node", nodeId, "--yes"],
            { cwd: repo.dir, format: "json" },
        );

        expect(result.exitCode).toBe(0);
        expect(result.json.pendingApproval.request.title).toBe("Permission request");
        expect(result.json.pendingApproval.request.requestedScopes).toEqual([
            "read:data",
            "write:config",
        ]);
        expect(result.json.pendingApproval.request.options).toHaveLength(2);
    });

    test("approve includes iteration and note in output", () => {
        const repo = createTempRepo();
        const runId = "test-run-iteration";
        const nodeId = "approval-node";
        
        seedApprovalGate(
            repo,
            runId,
            nodeId,
            { title: "Loop iteration approval" },
            {
                iteration: 3,
                note: "Approver: admin@example.com",
            }
        );

        const result = runSmithers(
            ["approve", runId, "--node", nodeId, "--yes"],
            { cwd: repo.dir, format: "json" },
        );

        expect(result.exitCode).toBe(0);
        expect(result.json.pendingApproval.iteration).toBe(3);
        expect(result.json.pendingApproval.note).toBe("Approver: admin@example.com");
    });

    test("approve with --node flag selects specified node", () => {
        const repo = createTempRepo();
        const runId = "test-run-with-node";
        seedMultipleApprovals(repo, runId);

        const result = runSmithers(
            ["approve", runId, "--node", "node-1", "--yes"],
            { cwd: repo.dir, format: "json" },
        );

        expect(result.exitCode).toBe(0);
        expect(result.json.nodeId).toBe("node-1");
    });
});

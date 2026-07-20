import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createSnapshotServer, nextSnapshotSocketPath } from "@smithers-orchestrator/engine/snapshotServer";
import { runSnapshotHookOnce } from "../src/snapshot-hook.js";

const stdinOf = (str) => Readable.from([str]);

describe("smithers snapshot-hook", () => {
    test("exits 0 when no socket is configured (durability off)", async () => {
        const r = await runSnapshotHookOnce({ env: {}, stdin: stdinOf("{}") });
        expect(r.exitCode).toBe(0);
    });

    test("forwards the Claude PostToolUse payload to the socket and exits 0", async () => {
        const seen = [];
        const server = await createSnapshotServer({
            socketPath: nextSnapshotSocketPath(),
            onHook: async (p) => { seen.push(p); return { ok: true, seq: 3 }; },
        });
        try {
            const hookJson = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "a.ts" }, tool_use_id: "t9" });
            const r = await runSnapshotHookOnce({
                env: { SMITHERS_SNAPSHOT_SOCK: server.socketPath, SMITHERS_RUN_ID: "r1" },
                stdin: stdinOf(hookJson),
            });
            expect(r.exitCode).toBe(0);
            expect(seen).toHaveLength(1);
            expect(seen[0].toolName).toBe("Edit");
            expect(seen[0].filePath).toBe("a.ts");
            expect(seen[0].toolUseId).toBe("t9");
            expect(seen[0].label).toBe("Edit a.ts");
        }
        finally { server.close(); }
    });

    test("a failed request spools a durable gap and still exits 0 (fail-open)", async () => {
        const spooled = [];
        const r = await runSnapshotHookOnce({
            env: { SMITHERS_SNAPSHOT_SOCK: "/nonexistent/smithers-snap.sock", SMITHERS_RUN_ID: "r1" },
            stdin: stdinOf("{}"),
            spool: (rid, gap) => spooled.push([rid, gap]),
            timeoutMs: 300,
        });
        expect(r.exitCode).toBe(0);
        expect(spooled).toHaveLength(1);
        expect(spooled[0][0]).toBe("r1");
        expect(spooled[0][1].source).toBe("hook");
    });
});

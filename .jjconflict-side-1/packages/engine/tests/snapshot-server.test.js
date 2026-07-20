import { describe, expect, test } from "bun:test";
import * as net from "node:net";
import { createSnapshotServer, nextSnapshotSocketPath } from "../src/snapshotServer.js";

/** Connect, send one JSON line, read one JSON line back, close. */
function sendHook(socketPath, payload) {
    return new Promise((resolve, reject) => {
        const client = net.connect(socketPath, () => client.write(`${JSON.stringify(payload)}\n`));
        let buf = "";
        client.setEncoding("utf8");
        client.on("data", (chunk) => {
            buf += chunk;
            const nl = buf.indexOf("\n");
            if (nl === -1) return;
            client.end();
            try { resolve(JSON.parse(buf.slice(0, nl) || "{}")); }
            catch { resolve({}); }
        });
        client.on("error", reject);
    });
}

describe("createSnapshotServer", () => {
    test("routes a hook request to onHook and returns the ack", async () => {
        const seen = [];
        const server = await createSnapshotServer({
            socketPath: nextSnapshotSocketPath(),
            onHook: async (p) => { seen.push(p); return { ok: true, seq: 7 }; },
        });
        try {
            const ack = await sendHook(server.socketPath, { toolName: "Edit", filePath: "a.ts", toolUseId: "t1" });
            expect(ack).toEqual({ ok: true, seq: 7 });
            expect(seen).toHaveLength(1);
            expect(seen[0].toolUseId).toBe("t1");
        }
        finally { server.close(); }
    });

    test("a throwing onHook still returns an ack and the server stays up", async () => {
        const server = await createSnapshotServer({
            socketPath: nextSnapshotSocketPath(),
            onHook: async () => { throw new Error("boom"); },
        });
        try {
            const ack = await sendHook(server.socketPath, {});
            expect(ack.ok).toBe(false);
            // Still serving a second request.
            const ack2 = await sendHook(server.socketPath, {});
            expect(ack2.ok).toBe(false);
        }
        finally { server.close(); }
    });
});

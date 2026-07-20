// `smithers snapshot-hook` — invoked by a Claude Code PostToolUse hook. Reads the
// hook JSON on stdin, connects to the engine's per-run snapshot socket
// (SMITHERS_SNAPSHOT_SOCK), and requests a strict Tier 1 snapshot at this tool
// boundary. Fail-open: it ALWAYS exits 0 so it can never block the agent, and on
// failure it records a durable gap (which the engine's spool drains) so the miss
// is visible.

import * as net from "node:net";
import { appendGap, defaultGapSpoolPath } from "@smithers-orchestrator/engine/durabilityGapSpool";

/** Read a whole stream to a string. */
function readAll(stream) {
    return new Promise((resolve) => {
        let buf = "";
        if (!stream || stream.destroyed) { resolve(""); return; }
        stream.setEncoding("utf8");
        stream.on("data", (c) => { buf += c; });
        stream.on("end", () => resolve(buf));
        stream.on("error", () => resolve(buf));
    });
}

/** Send one JSON line to the socket, await one JSON line back, bounded by timeoutMs. */
function requestSnapshot(socketPath, payload, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
        const client = net.connect(socketPath, () => client.write(`${JSON.stringify(payload)}\n`));
        const timer = setTimeout(() => { try { client.destroy(); } catch { /* noop */ } finish({ ok: false, error: "timeout" }); }, timeoutMs);
        let buf = "";
        client.setEncoding("utf8");
        client.on("data", (chunk) => {
            buf += chunk;
            const nl = buf.indexOf("\n");
            if (nl === -1) return;
            clearTimeout(timer);
            try { client.end(); } catch { /* noop */ }
            try { finish(JSON.parse(buf.slice(0, nl) || "{}")); }
            catch { finish({ ok: false, error: "bad-ack" }); }
        });
        client.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: e instanceof Error ? e.message : String(e) }); });
    });
}

/**
 * @param {{
 *   stdin?: NodeJS.ReadableStream,
 *   env?: Record<string, string | undefined>,
 *   timeoutMs?: number,
 *   request?: (socketPath: string, payload: any, timeoutMs: number) => Promise<{ ok: boolean, error?: string }>,
 *   spool?: (runId: string, gap: any) => void,
 * }} [opts]
 * @returns {Promise<{ exitCode: number }>}
 */
export async function runSnapshotHookOnce(opts = {}) {
    const env = opts.env ?? process.env;
    const socketPath = env.SMITHERS_SNAPSHOT_SOCK;
    const runId = env.SMITHERS_RUN_ID ?? "unknown";
    const request = opts.request ?? requestSnapshot;
    const spool = opts.spool ?? ((rid, gap) => appendGap(defaultGapSpoolPath(rid), gap));

    // No socket configured: durability is off for this run. Nothing to do.
    if (!socketPath) return { exitCode: 0 };

    let hook = {};
    try { hook = JSON.parse((await readAll(opts.stdin ?? process.stdin)) || "{}"); }
    catch { hook = {}; }

    const toolName = hook.tool_name ?? hook.toolName;
    const filePath = hook.tool_input?.file_path ?? hook.filePath;
    const payload = {
        toolName,
        filePath,
        toolUseId: hook.tool_use_id ?? hook.toolUseId ?? null,
        label: filePath ? `${toolName ?? "tool"} ${filePath}` : toolName,
    };

    let result;
    try { result = await request(socketPath, payload, opts.timeoutMs ?? 3000); }
    catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }

    if (!result?.ok) {
        spool(runId, { runId, source: "hook", reason: result?.error ?? "hook-failed", toolName, filePath, ts: Date.now() });
    }
    // Always succeed: a durability hook must never block the agent.
    return { exitCode: 0 };
}

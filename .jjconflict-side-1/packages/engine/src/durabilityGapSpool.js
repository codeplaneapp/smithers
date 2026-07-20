// Durable record of durability gaps (a snapshot we could not take). Written to a
// newline-delimited JSON spool file OUTSIDE the worktree so it survives an engine
// crash and is never re-ingested by the watcher. drainGaps() reads + clears it for
// tooling/diagnostics. All functions are best-effort and never throw — a gap log
// must not become a second failure.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Per-run spool path under the OS temp dir (outside any worktree).
 * @param {string} runId
 * @returns {string}
 */
export function defaultGapSpoolPath(runId) {
    // No '.' in the safe set, so a runId like "../x" can't become a "../" segment.
    const safe = String(runId).replace(/[^a-zA-Z0-9_-]/g, "_") || "run";
    return path.join(os.tmpdir(), "smithers-durability", `${safe}.gaps.ndjson`);
}

/**
 * Append one gap record as an NDJSON line. Atomic per-line append; concurrent
 * writers from multiple processes interleave safely because drain skips torn lines.
 * @param {string} spoolPath
 * @param {Record<string, unknown>} record
 * @returns {void}
 */
export function appendGap(spoolPath, record) {
    try {
        fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
        fs.appendFileSync(spoolPath, `${JSON.stringify(record)}\n`);
    }
    catch { /* best-effort: a gap log must not throw */ }
}

/**
 * Read all spooled gaps and clear the spool. Skips any torn/partial line.
 * @param {string} spoolPath
 * @returns {Array<Record<string, unknown>>}
 */
export function drainGaps(spoolPath) {
    let content;
    try { content = fs.readFileSync(spoolPath, "utf8"); }
    catch { return []; }
    /** @type {Array<Record<string, unknown>>} */
    const gaps = [];
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { gaps.push(JSON.parse(trimmed)); }
        catch { /* torn line from an interleaved append; skip it */ }
    }
    try { fs.rmSync(spoolPath, { force: true }); }
    catch { /* best-effort */ }
    return gaps;
}

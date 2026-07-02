import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findAndOpenDb } from "./find-db.js";

/** @typedef {(opts: { code: string; message: string; exitCode?: number }) => unknown} FailFn */

const DEFAULT_BUG_ENDPOINT = "https://bug.smithers.sh/api/bugs";
const MAX_RUN_EVENTS = 50;
const EVENTS_PAGE_SIZE = 1000;
const POST_TIMEOUT_MS = 15_000;
/** Object keys whose values are always redacted wholesale. */
const SECRET_KEY_PATTERN = /(?:api[-_]?key|[-_]key$|^key$|token|secret|password|credential|authorization)/i;

/**
 * Redact secret-looking material inside a free-form string: bearer tokens,
 * `sk-...` API keys, and `SOME_KEY=value` / `"someToken": "value"` pairs whose
 * key looks like an env secret (KEY / TOKEN / SECRET / PASSWORD).
 *
 * @param {string} text
 * @returns {string}
 */
function scrubText(text) {
    return text
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, "Bearer [REDACTED]")
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
        .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?)=("[^"]*"|'[^']*'|\S+)/g, "$1=[REDACTED]")
        .replace(/"([A-Za-z0-9_-]*(?:key|token|secret|password|credential)[A-Za-z0-9_-]*)"(\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '"$1"$2"[REDACTED]"');
}

/**
 * Recursively scrub a JSON-safe value. String leaves go through
 * {@link scrubText}; object entries whose key looks like a secret are
 * redacted wholesale.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function scrubValue(value) {
    if (typeof value === "string") return scrubText(value);
    if (Array.isArray(value)) return value.map((item) => scrubValue(item));
    if (value && typeof value === "object") {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : scrubValue(entry);
        }
        return out;
    }
    return value;
}

/**
 * @returns {string}
 */
function readCliVersion() {
    try {
        const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
        const parsed = JSON.parse(raw);
        return typeof parsed.version === "string" ? parsed.version : "unknown";
    }
    catch {
        return "unknown";
    }
}

/**
 * Best-effort human message out of a run's errorJson column (which may be a
 * JSON object, a JSON string, or plain text).
 *
 * @param {string | null | undefined} errorJson
 * @returns {string | null}
 */
function runErrorMessage(errorJson) {
    if (!errorJson) return null;
    try {
        const parsed = JSON.parse(errorJson);
        if (typeof parsed === "string") return parsed;
        if (parsed && typeof parsed === "object") {
            const message = parsed.message ?? parsed.error ?? parsed.reason;
            if (typeof message === "string") return message;
        }
        return errorJson;
    }
    catch {
        return errorJson;
    }
}

/**
 * Read the run row plus the tail (~last 50) of its event history from the
 * nearest workspace DB, using the same read path as `ps`/`events`.
 *
 * @param {string} runId
 * @returns {Promise<{ run: any; events: any[] } | undefined>}
 */
async function gatherRun(runId) {
    const { adapter, cleanup } = await findAndOpenDb();
    try {
        const run = await adapter.getRun(runId);
        if (!run) return undefined;
        let lastSeq = -1;
        /** @type {any[]} */
        let tail = [];
        while (true) {
            const page = await adapter.listEvents(runId, lastSeq, EVENTS_PAGE_SIZE);
            if (!Array.isArray(page) || page.length === 0) break;
            lastSeq = page[page.length - 1].seq;
            tail = tail.concat(page).slice(-MAX_RUN_EVENTS);
            if (page.length < EVENTS_PAGE_SIZE) break;
        }
        const events = tail.map((event) => {
            let payload = event.payloadJson ?? null;
            if (typeof payload === "string") {
                try {
                    payload = JSON.parse(payload);
                }
                catch {
                    // keep the raw string when it is not JSON
                }
            }
            return {
                seq: event.seq,
                timestampMs: event.timestampMs,
                type: event.type,
                payload,
            };
        });
        return { run, events };
    }
    finally {
        cleanup?.();
    }
}

/**
 * `smithers bug [--run <runId>] [--title <t>] [--body <b>] [--json] [--endpoint <url>]`
 *
 * Files a bug report (smithers version, platform, and optionally a run's
 * status/error/recent events, secrets scrubbed) to
 * `SMITHERS_BUG_ENDPOINT` || `--endpoint` || the default bug.smithers.sh
 * endpoint. On POST failure the payload is saved under
 * `.smithers/bug-reports/<timestamp>.json` so nothing is lost. Exits 0 only
 * when the report was filed.
 *
 * @param {any} c
 * @param {FailFn} fail
 */
export async function runBugCommand(c, fail) {
    const endpoint = process.env.SMITHERS_BUG_ENDPOINT || c.options.endpoint || DEFAULT_BUG_ENDPOINT;
    const runId = c.options.run;
    if (!runId && !c.options.title && !c.options.body) {
        return fail({
            code: "BUG_REPORT_EMPTY",
            message: "Nothing to report: pass --run <runId> to attach a failing run, or --title/--body to describe the bug.",
            exitCode: 4,
        });
    }
    /** @type {{ run: any; events: any[] } | undefined} */
    let gathered;
    if (runId) {
        /** @type {unknown} */
        let runReadError;
        try {
            gathered = await gatherRun(runId);
        }
        catch (err) {
            runReadError = err;
        }
        if (!gathered) {
            const reason = runReadError
                ? `Could not read run ${runId}: ${runReadError?.message ?? String(runReadError)}`
                : `Run not found: ${runId}`;
            // A missing run / unreadable workspace DB must not lose a
            // hand-written report; degrade to a run-less payload when the user
            // gave us text, refuse otherwise.
            if (!c.options.title && !c.options.body) {
                return fail({
                    code: runReadError ? "BUG_REPORT_RUN_UNREADABLE" : "RUN_NOT_FOUND",
                    message: reason,
                    exitCode: 4,
                });
            }
            process.stderr.write(`[smithers] ${reason}; filing without run details\n`);
        }
    }
    const runError = gathered ? runErrorMessage(gathered.run.errorJson) : null;
    let title = c.options.title;
    if (!title && gathered) {
        title = runError
            ? `Run ${gathered.run.runId} failed: ${runError.slice(0, 120)}`
            : `Run ${gathered.run.runId} (${gathered.run.status})`;
    }
    if (!title) {
        title = c.options.body.slice(0, 120);
    }
    const payload = /** @type {Record<string, unknown>} */ (scrubValue({
        title,
        body: c.options.body ?? "",
        smithersVersion: readCliVersion(),
        platform: {
            os: process.platform,
            arch: process.arch,
            bunVersion: typeof Bun !== "undefined" ? Bun.version : process.version,
        },
        createdAtMs: Date.now(),
        run: gathered
            ? {
                runId: gathered.run.runId,
                workflowName: gathered.run.workflowName,
                workflowPath: gathered.run.workflowPath,
                status: gathered.run.status,
                error: runError,
                events: gathered.events,
            }
            : null,
    }));
    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`bug endpoint returned HTTP ${response.status}`);
        }
        const data = await response.json().catch(() => ({}));
        const id = typeof data?.id === "string" ? data.id : undefined;
        const url = typeof data?.url === "string" ? data.url : undefined;
        if (c.options.json) {
            process.stdout.write(`${JSON.stringify({ id, url, endpoint, payload }, null, 2)}\n`);
        }
        else if (c.format !== "json") {
            console.log(`Filed bug${id ? ` ${id}` : ""}${url ? `: ${url}` : ""}`);
        }
        return c.ok({ id, url, endpoint });
    }
    catch (err) {
        // Never lose a report: persist the payload locally and point at it.
        let savedPath;
        try {
            const dir = resolve(process.cwd(), ".smithers", "bug-reports");
            mkdirSync(dir, { recursive: true });
            savedPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
            writeFileSync(savedPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        }
        catch {
            savedPath = undefined;
        }
        const reason = err?.message ?? String(err);
        const saved = savedPath
            ? ` The report was saved to ${savedPath} — retry later with the same command.`
            : "";
        return fail({
            code: "BUG_REPORT_POST_FAILED",
            message: `Could not reach ${endpoint}: ${reason}.${saved}`,
            exitCode: 1,
        });
    }
}

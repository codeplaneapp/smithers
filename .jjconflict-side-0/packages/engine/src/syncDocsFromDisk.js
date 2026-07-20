import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { Effect } from "effect";

const DOC_KIND_BY_ROOT = {
    tickets: "ticket",
    plans: "plan",
    specs: "spec",
    proposals: "proposal",
};

/**
 * @param {string} value
 * @returns {string}
 */
function sha256Hex(value) {
    return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} docPath
 * @returns {"ticket" | "plan" | "spec" | "proposal" | null}
 */
function kindForDocPath(docPath) {
    const root = docPath.split("/", 1)[0];
    return DOC_KIND_BY_ROOT[root] ?? null;
}

/**
 * @param {string} docPath
 * @returns {string | null}
 */
function normalizeDocPath(docPath) {
    const normalized = docPath.replace(/\\/g, "/").replace(/^\.smithers\/+/, "").replace(/^\/+/, "");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length < 2 || parts.some((part) => part === "." || part === ".." || part === ".git" || part === ".jj")) {
        return null;
    }
    if (!parts[parts.length - 1].endsWith(".md")) {
        return null;
    }
    if (!kindForDocPath(parts.join("/"))) {
        return null;
    }
    return parts.join("/");
}

/**
 * @param {string} cwd
 * @param {string} docPath
 * @returns {string}
 */
function absoluteDocPath(cwd, docPath) {
    const smithersRoot = resolve(cwd, ".smithers");
    const absolute = resolve(smithersRoot, ...docPath.split("/"));
    if (absolute !== smithersRoot && !absolute.startsWith(`${smithersRoot}${sep}`)) {
        throw new Error(`Refusing to sync doc path outside .smithers: ${docPath}`);
    }
    return absolute;
}

/**
 * @param {Effect.Effect<unknown>} effect
 */
function emit(effect) {
    void Effect.runPromise(effect).catch(() => {});
}

/**
 * @param {string} event
 * @param {{ path: string; kind: string; contentHash: string; deletedAtMs?: number | null }} row
 */
function emitDocLog(event, row) {
    // Info-level (not debug) so the server-side watcher path is observable at
    // default log levels, on par with the client materializer's OTLP spans.
    emit(Effect.logInfo(event).pipe(Effect.annotateLogs({
        path: row.path,
        kind: row.kind,
        hash: row.contentHash,
        deletedAtMs: row.deletedAtMs ?? null,
    }), Effect.withLogSpan("docs:file-sync")));
}

/**
 * Surface a backpressure truncation: a scan or burst that exceeds `maxPaths`
 * sheds the overflow, so emit a structured warning rather than dropping docs
 * silently (the "no silent caps" bar).
 *
 * @param {{ requested: number; maxPaths: number; dropped: number }} info
 */
function emitDocTruncation(info) {
    emit(Effect.logWarning("docs.sync.truncated").pipe(Effect.annotateLogs({
        requested: info.requested,
        maxPaths: info.maxPaths,
        dropped: info.dropped,
    }), Effect.withLogSpan("docs:file-sync")));
}

/**
 * @param {string} dir
 * @param {string[]} out
 * @param {number} maxPaths
 * @returns {Promise<void>}
 */
async function discoverDocsInDir(dir, out, maxPaths) {
    if (out.length >= maxPaths) return;
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (out.length >= maxPaths) return;
        if (entry.name === ".git" || entry.name === ".jj") continue;
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
            await discoverDocsInDir(child, out, maxPaths);
        }
        else if (entry.isFile() && entry.name.endsWith(".md")) {
            out.push(child);
        }
    }
}

/**
 * @param {string} cwd
 * @param {number} maxPaths
 * @returns {Promise<string[]>}
 */
async function discoverDocPaths(cwd, maxPaths) {
    const smithersRoot = resolve(cwd, ".smithers");
    const absolutePaths = [];
    for (const root of Object.keys(DOC_KIND_BY_ROOT)) {
        await discoverDocsInDir(join(smithersRoot, root), absolutePaths, maxPaths);
    }
    return absolutePaths
        .map((absolute) => normalizeDocPath(absolute.slice(smithersRoot.length + 1)))
        .filter((path) => typeof path === "string");
}

/**
 * @param {{
 *   cwd: string;
 *   adapter: { upsertDocRow: (row: Record<string, unknown>) => PromiseLike<unknown> };
 *   paths?: readonly string[];
 *   nowMs?: () => number;
 *   maxPaths?: number;
 * }} options
 * @returns {Promise<{ upserted: number, tombstoned: number, skipped: number, dropped: number }>}
 */
export async function syncDocsFromDisk(options) {
    const {
        cwd,
        adapter,
        paths,
        nowMs = () => Date.now(),
        maxPaths = 4_096,
    } = options;
    // Discover/accept one over the cap so an exceeded budget is detectable
    // instead of silently truncated.
    const allPaths = paths === undefined
        ? await discoverDocPaths(cwd, maxPaths + 1)
        : [...paths];
    const dropped = Math.max(0, allPaths.length - maxPaths);
    if (dropped > 0) {
        emitDocTruncation({ requested: allPaths.length, maxPaths, dropped });
    }
    const rawPaths = allPaths.slice(0, maxPaths);
    const docPaths = [...new Set(rawPaths)]
        .map((path) => normalizeDocPath(path))
        .filter((path) => typeof path === "string");
    let upserted = 0;
    let tombstoned = 0;
    let skipped = rawPaths.length - docPaths.length;
    for (const docPath of docPaths) {
        const kind = kindForDocPath(docPath);
        if (!kind) {
            skipped += 1;
            continue;
        }
        const filePath = absoluteDocPath(cwd, docPath);
        const updatedAtMs = nowMs();
        try {
            const content = await fs.readFile(filePath, "utf8");
            const row = {
                path: docPath,
                kind,
                content,
                contentHash: sha256Hex(content),
                updatedAtMs,
                deletedAtMs: null,
            };
            await adapter.upsertDocRow(row);
            emitDocLog("docs.watcher.upsert", row);
            upserted += 1;
        }
        catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                const row = {
                    path: docPath,
                    kind,
                    content: "",
                    contentHash: sha256Hex(""),
                    updatedAtMs,
                    deletedAtMs: updatedAtMs,
                };
                await adapter.upsertDocRow(row);
                emitDocLog("docs.watcher.tombstone", row);
                tombstoned += 1;
                continue;
            }
            throw error;
        }
    }
    return { upserted, tombstoned, skipped, dropped };
}

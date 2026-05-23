import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { logDebug, logInfo } from "@smithers-orchestrator/observability/logging";
/** @typedef {import("./WatchTreeOptions.ts").WatchTreeOptions} WatchTreeOptions */

const DEFAULT_IGNORE = [
    "node_modules",
    ".git",
    ".jj",
    ".smithers",
];
const MIN_POLL_MS = 1000;
const MAX_POLL_MS = 10_000;
const MAX_POLL_FILES = 5000;
class HotWatchScanLimitError extends Error {
    constructor() {
        super(`Hot watch polling skipped after ${MAX_POLL_FILES} files.`);
        this.name = "HotWatchScanLimitError";
    }
}
export class WatchTree {
    watchers = [];
    rootDir;
    ignore;
    debounceMs;
    changedFiles = new Set();
    fileSignatures = new Map();
    debounceTimer = null;
    pollTimer = null;
    polling = false;
    pollingDisabled = false;
    currentPollIntervalMs = MIN_POLL_MS;
    waitResolve = null;
    closed = false;
    /**
   * @param {string} rootDir
   * @param {WatchTreeOptions} [opts]
   */
    constructor(rootDir, opts) {
        this.rootDir = resolve(rootDir);
        this.ignore = opts?.ignore ?? DEFAULT_IGNORE;
        this.debounceMs = opts?.debounceMs ?? 100;
    }
    /** Start watching. Call once. */
    async start() {
        await Effect.runPromise(this.startEffect());
    }
    /**
     * Returns a promise that resolves with changed file paths
     * the next time file changes are detected (after debounce).
     * Can be called repeatedly.
     */
    wait() {
        // If there are already buffered changes, resolve immediately
        if (this.changedFiles.size > 0) {
            const files = [...this.changedFiles];
            this.changedFiles.clear();
            return Promise.resolve(files);
        }
        return Effect.runPromise(this.waitEffect());
    }
    /** Stop all watchers and clean up. */
    close() {
        this.closed = true;
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        if (this.pollTimer)
            clearTimeout(this.pollTimer);
        for (const w of this.watchers) {
            try {
                w.close();
            }
            catch { }
        }
        this.watchers = [];
        // Resolve any pending wait with empty array
        if (this.waitResolve) {
            this.waitResolve([]);
            this.waitResolve = null;
        }
        logInfo("closed hot watch tree", {
            rootDir: this.rootDir,
        }, "hot:watch");
    }
    startEffect() {
        return Effect.tryPromise({
            try: async () => {
                try {
                    this.fileSignatures = await this.scanFileSignatures(this.rootDir);
                }
                catch (error) {
                    this.pollingDisabled = true;
                    this.fileSignatures = new Map();
                    if (error instanceof HotWatchScanLimitError) {
                        logInfo("hot watch polling disabled by file count guard", {
                            rootDir: this.rootDir,
                            maxFiles: MAX_POLL_FILES,
                        }, "hot:watch");
                    }
                    else {
                        logInfo("hot watch polling disabled after initial scan failed", {
                            rootDir: this.rootDir,
                            errorName: error instanceof Error ? error.name : typeof error,
                        }, "hot:watch");
                    }
                }
                await this.watchDir(this.rootDir);
                if (!this.pollingDisabled) {
                    this.startPolling();
                }
            },
            catch: (cause) => toSmithersError(cause, "start hot watch tree"),
        }).pipe(Effect.annotateLogs({
            rootDir: this.rootDir,
            debounceMs: this.debounceMs,
        }), Effect.withLogSpan("hot:watch-start"));
    }
    waitEffect() {
        return Effect.async((resume) => {
            if (this.changedFiles.size > 0) {
                const files = [...this.changedFiles];
                this.changedFiles.clear();
                resume(Effect.succeed(files));
                return;
            }
            this.waitResolve = (files) => {
                resume(Effect.succeed(files));
            };
            return Effect.sync(() => {
                if (this.waitResolve) {
                    this.waitResolve = null;
                }
            });
        }).pipe(Effect.annotateLogs({
            rootDir: this.rootDir,
        }), Effect.withLogSpan("hot:watch-wait"));
    }
    /**
   * @param {string} name
   * @returns {boolean}
   */
    shouldIgnore(name) {
        return this.ignore.includes(name) || name.startsWith(".");
    }
    pollIntervalMs() {
        return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, this.debounceMs * 4));
    }
    resetPollBackoff() {
        this.currentPollIntervalMs = this.pollIntervalMs();
    }
    advancePollBackoff(changed) {
        if (changed) {
            this.resetPollBackoff();
            return;
        }
        this.currentPollIntervalMs = Math.min(MAX_POLL_MS, Math.max(this.pollIntervalMs(), this.currentPollIntervalMs * 2));
    }
    scheduleNextPoll() {
        if (this.pollTimer || this.closed || this.pollingDisabled)
            return;
        this.pollTimer = setTimeout(() => {
            this.pollTimer = null;
            void this.pollOnce().finally(() => {
                this.scheduleNextPoll();
            });
        }, this.currentPollIntervalMs);
    }
    startPolling() {
        if (this.pollTimer || this.closed || this.pollingDisabled)
            return;
        this.resetPollBackoff();
        this.scheduleNextPoll();
    }
    async pollOnce() {
        if (this.closed || this.polling || this.pollingDisabled)
            return false;
        this.polling = true;
        try {
            const next = await this.scanFileSignatures(this.rootDir);
            const changed = this.recordScanChanges(next);
            this.advancePollBackoff(changed);
            return changed;
        }
        catch (error) {
            if (error instanceof HotWatchScanLimitError) {
                this.pollingDisabled = true;
                logInfo("hot watch polling disabled by file count guard", {
                    rootDir: this.rootDir,
                    maxFiles: MAX_POLL_FILES,
                }, "hot:watch");
            }
            else {
                this.advancePollBackoff(false);
            }
            // Ignore transient filesystem races; the next interval will retry.
            return false;
        }
        finally {
            this.polling = false;
        }
    }
    /**
   * @param {string} dir
   * @returns {Promise<Map<string, string>>}
   */
    async scanFileSignatures(dir) {
        const files = new Map();
        await this.scanDir(dir, files);
        return files;
    }
    /**
   * @param {string} dir
   * @param {Map<string, string>} files
   * @returns {Promise<void>}
   */
    async scanDir(dir, files) {
        if (this.closed)
            return;
        const baseName = basename(dir);
        if (baseName && this.shouldIgnore(baseName) && dir !== this.rootDir)
            return;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (this.shouldIgnore(entry.name))
                continue;
            if (files.size >= MAX_POLL_FILES) {
                throw new HotWatchScanLimitError();
            }
            const fullPath = resolve(dir, entry.name);
            if (entry.isDirectory()) {
                await this.scanDir(fullPath, files);
            }
            else if (entry.isFile()) {
                const info = await stat(fullPath).catch(() => null);
                if (info?.isFile()) {
                    files.set(fullPath, `${info.mtimeMs}:${info.size}`);
                }
            }
        }
    }
    /**
   * @param {Map<string, string>} next
   */
    recordScanChanges(next) {
        let changed = false;
        for (const [filePath, signature] of next) {
            if (this.fileSignatures.get(filePath) !== signature) {
                this.onFileChange(filePath);
                changed = true;
            }
        }
        for (const filePath of this.fileSignatures.keys()) {
            if (!next.has(filePath)) {
                this.onFileChange(filePath);
                changed = true;
            }
        }
        this.fileSignatures = next;
        return changed;
    }
    /**
   * @param {string} dir
   * @returns {Promise<void>}
   */
    async watchDir(dir) {
        if (this.closed)
            return;
        const baseName = basename(dir);
        if (baseName && this.shouldIgnore(baseName) && dir !== this.rootDir)
            return;
        try {
            const watcher = watch(dir, (eventType, filename) => {
                if (!filename || this.closed)
                    return;
                // Ignore hidden files and ignored dirs
                const parts = filename.split("/");
                if (parts.some((p) => this.shouldIgnore(p)))
                    return;
                const fullPath = resolve(dir, filename);
                logDebug("hot watch tree observed file change", {
                    rootDir: this.rootDir,
                    eventType,
                    fullPath,
                }, "hot:watch");
                this.onFileChange(fullPath);
                this.resetPollBackoff();
                void this.pollOnce();
            });
            this.watchers.push(watcher);
            // Recursively watch subdirectories
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !this.shouldIgnore(entry.name)) {
                    await this.watchDir(resolve(dir, entry.name));
                }
            }
        }
        catch {
            // Directory may have been deleted; ignore
        }
    }
    /**
   * @param {string} filePath
   */
    onFileChange(filePath) {
        this.changedFiles.add(filePath);
        // Debounce: reset timer on each change
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.flush();
        }, this.debounceMs);
    }
    flush() {
        if (this.changedFiles.size === 0)
            return;
        const files = [...this.changedFiles];
        this.changedFiles.clear();
        logInfo("flushing hot watch changes", {
            rootDir: this.rootDir,
            changedFileCount: files.length,
            changedFiles: files.join(","),
        }, "hot:watch");
        if (this.waitResolve) {
            this.waitResolve(files);
            this.waitResolve = null;
        }
    }
}

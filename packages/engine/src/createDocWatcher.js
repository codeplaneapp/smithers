import * as fs from "node:fs";

const DOC_ROOTS = new Set(["tickets", "plans", "specs", "proposals"]);

/**
 * @param {string} relPath
 * @returns {string}
 */
function normalizeRelPath(relPath) {
    return relPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

/**
 * @param {string} relPath
 * @returns {string | null}
 */
function docPathFromRelativePath(relPath) {
    const normalized = normalizeRelPath(relPath);
    if (!normalized || normalized.split("/").some((segment) => segment === ".jj" || segment === ".git")) {
        return null;
    }
    const parts = normalized.split("/");
    if (parts[0] !== ".smithers" || parts.length < 3) {
        return null;
    }
    if (!DOC_ROOTS.has(parts[1])) {
        return null;
    }
    if (!parts[parts.length - 1].endsWith(".md")) {
        return null;
    }
    return parts.slice(1).join("/");
}

/**
 * @param {string} cwd
 * @param {(relPath: string) => void} onChange
 * @returns {{ close: () => void } | null}
 */
function defaultWatch(cwd, onChange) {
    try {
        const watcher = fs.watch(cwd, { recursive: true }, (_event, filename) => {
            if (filename != null) onChange(typeof filename === "string" ? filename : String(filename));
        });
        watcher.on("error", () => {});
        return {
            close() {
                try {
                    watcher.close();
                }
                catch {
                    // already closed
                }
            },
        };
    }
    catch {
        return null;
    }
}

/**
 * Watch markdown artifacts under `.smithers/{tickets,plans,specs,proposals}` and
 * call `onSettle` with the affected DB doc paths after a trailing-idle debounce.
 *
 * @param {{
 *   cwd: string;
 *   onSettle: (paths: string[]) => void;
 *   debounceMs?: number;
 *   maxPendingPaths?: number;
 *   onDrop?: (info: { path: string; droppedTotal: number; pendingSize: number }) => void;
 *   watch?: (cwd: string, onChange: (relPath: string) => void) => ({ close: () => void } | null);
 *   setTimeoutFn?: (fn: () => void, ms: number) => unknown;
 *   clearTimeoutFn?: (handle: unknown) => void;
 * }} deps
 * @returns {{ close: () => void, flush: () => void, watching: boolean, droppedCount: () => number }}
 */
export function createDocWatcher(deps) {
    const {
        cwd,
        onSettle,
        debounceMs = 150,
        maxPendingPaths = 2_048,
        onDrop,
        watch = defaultWatch,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
    } = deps;

    /** @type {Set<string>} */
    const pending = new Set();
    let timer = null;
    let closed = false;
    let dropped = 0;

    const flush = () => {
        timer = null;
        if (closed || pending.size === 0) {
            return;
        }
        const paths = [...pending].sort();
        pending.clear();
        onSettle(paths);
    };

    const arm = () => {
        if (closed) return;
        if (timer != null) clearTimeoutFn(timer);
        timer = setTimeoutFn(flush, debounceMs);
    };

    const handle = watch(cwd, (relPath) => {
        if (closed) return;
        const docPath = docPathFromRelativePath(relPath);
        if (!docPath) return;
        if (pending.size >= maxPendingPaths && !pending.has(docPath)) {
            // Backpressure: the pending set is full. Shed the oldest path so the
            // newest edit is retained, and surface the drop — a silent eviction
            // would lose an edit until process restart with no signal.
            const oldest = pending.values().next().value;
            if (oldest !== undefined) {
                pending.delete(oldest);
                dropped += 1;
                onDrop?.({ path: oldest, droppedTotal: dropped, pendingSize: pending.size });
            }
        }
        pending.add(docPath);
        arm();
    });

    return {
        watching: handle != null,
        flush,
        droppedCount: () => dropped,
        close() {
            closed = true;
            if (timer != null) clearTimeoutFn(timer);
            pending.clear();
            handle?.close?.();
        },
    };
}

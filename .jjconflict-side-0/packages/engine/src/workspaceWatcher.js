// Tier 2 durability substrate: watch a worktree and fire `onSettle` when the
// tree goes quiet (trailing-idle debounce). The engine wires `onSettle` to
// SnapshotService.snapshot({ source: "watch", tier: 2 }).
//
// Built on Node's recursive fs.watch (zero dependency). The watch backend is a
// DI seam so a future commit can swap in watchman / @parcel/watcher and so the
// debounce/ignore logic is testable without touching the real filesystem.
//
// `.jj/` and `.git/` are ignored unconditionally: jj writes its own metadata when
// we snapshot, and watching that would loop.

import * as fs from "node:fs";

/**
 * @param {string} relPath
 * @param {readonly string[]} ignoreDirs
 */
function isIgnored(relPath, ignoreDirs) {
    if (!relPath) return false;
    return relPath.split(/[\\/]/).some((segment) => ignoreDirs.includes(segment));
}

/**
 * Default watch backend: recursive fs.watch. Returns a closer, or null if the
 * platform/path cannot be watched (the watcher then runs as a safe no-op).
 *
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
                try { watcher.close(); }
                catch { /* already closed */ }
            },
        };
    }
    catch {
        return null;
    }
}

/**
 * @typedef {object} WorkspaceWatcherDeps
 * @property {string} cwd
 * @property {() => void} onSettle
 * @property {number} [debounceMs]
 * @property {readonly string[]} [ignoreDirs]
 * @property {(cwd: string, onChange: (relPath: string) => void) => ({ close: () => void } | null)} [watch]
 * @property {(fn: () => void, ms: number) => unknown} [setTimeoutFn]
 * @property {(handle: unknown) => void} [clearTimeoutFn]
 */

/**
 * @param {WorkspaceWatcherDeps} deps
 * @returns {{ close: () => void, watching: boolean }}
 */
export function createWorkspaceWatcher(deps) {
    const {
        cwd,
        onSettle,
        debounceMs = 150,
        ignoreDirs = [".jj", ".git"],
        watch = defaultWatch,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
    } = deps;

    let timer = null;
    let closed = false;

    const arm = () => {
        if (closed) return;
        if (timer != null) clearTimeoutFn(timer);
        timer = setTimeoutFn(() => {
            timer = null;
            if (!closed) onSettle();
        }, debounceMs);
    };

    const handle = watch(cwd, (relPath) => {
        if (closed) return;
        if (isIgnored(relPath, ignoreDirs)) return;
        arm();
    });

    return {
        watching: handle != null,
        close() {
            closed = true;
            if (timer != null) clearTimeoutFn(timer);
            handle?.close?.();
        },
    };
}

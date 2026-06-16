import { Effect } from "effect";
import { createDocWatcher } from "./createDocWatcher.js";
import { syncDocsFromDisk } from "./syncDocsFromDisk.js";

const NOOP_HANDLE = {
    active: false,
    async flush() {
        return { upserted: 0, tombstoned: 0, skipped: 0, dropped: 0 };
    },
    async stop() {},
};

/**
 * Emit a structured backpressure event when the watcher sheds a pending path,
 * so a dropped edit is observable instead of vanishing until process restart.
 *
 * @param {{ path: string; droppedTotal: number; pendingSize: number }} info
 */
function emitWatcherDrop(info) {
    void Effect.runPromise(Effect.logWarning("docs.watcher.dropped").pipe(Effect.annotateLogs({
        path: info.path,
        droppedTotal: info.droppedTotal,
        pendingSize: info.pendingSize,
    }), Effect.withLogSpan("docs:file-sync"))).catch(() => {});
}

/**
 * @param {{
 *   enabled: boolean;
 *   cwd?: string;
 *   adapter: { upsertDocRow?: (row: Record<string, unknown>) => PromiseLike<unknown> };
 *   nowMs?: () => number;
 *   createWatcher?: typeof createDocWatcher;
 *   syncOnStart?: boolean;
 * }} options
 * @returns {Promise<{ active: boolean, flush: (paths?: readonly string[]) => Promise<{ upserted: number, tombstoned: number, skipped: number, dropped: number }>, stop: () => Promise<void> }>}
 */
export async function startDocFileSync(options) {
    const {
        enabled,
        cwd,
        adapter,
        nowMs = () => Date.now(),
        createWatcher = createDocWatcher,
        syncOnStart = true,
    } = options;
    if (!enabled || !cwd || typeof adapter.upsertDocRow !== "function") {
        return NOOP_HANDLE;
    }

    let chain = Promise.resolve({ upserted: 0, tombstoned: 0, skipped: 0, dropped: 0 });
    const runSync = (paths) => {
        chain = chain
            .catch(() => ({ upserted: 0, tombstoned: 0, skipped: 0, dropped: 0 }))
            .then(() => syncDocsFromDisk({
                cwd,
                adapter: /** @type {{ upsertDocRow: (row: Record<string, unknown>) => PromiseLike<unknown> }} */ (adapter),
                ...(paths === undefined ? {} : { paths }),
                nowMs,
            }));
        return chain;
    };

    const watcher = createWatcher({
        cwd,
        onSettle: (paths) => {
            void runSync(paths);
        },
        onDrop: emitWatcherDrop,
    });

    if (syncOnStart) {
        void runSync(undefined);
    }

    return {
        active: true,
        flush: (paths) => runSync(paths),
        async stop() {
            watcher.flush?.();
            watcher.close();
            await chain.catch(() => undefined);
        },
    };
}

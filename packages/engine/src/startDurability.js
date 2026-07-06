// Compose the durability snapshot pieces into a start/stop handle the engine can
// drive around a single agent attempt. Returns a no-op handle when disabled, when
// there is no worktree, or when the worktree is not a jj repo (Tier 2 still needs
// jj as the store), so the engine call site stays a couple of lines.
//
// DI seams (isJjRepoFn / captureSnapshot / createWatcher) default to the real jj +
// fs watcher and are overridden in tests.

import { Effect } from "effect";
import { captureWorkspaceSnapshot, isJjRepo } from "@smithers-orchestrator/vcs/jj";
import { getPlatformLayer } from "./platform-layer.js";
import { createSnapshotService } from "./snapshotService.js";
import { createWorkspaceWatcher } from "./workspaceWatcher.js";
import { pruneWorkspaceDurability } from "./pruneWorkspaceDurability.js";
import { appendGap, defaultGapSpoolPath } from "./durabilityGapSpool.js";
import { createSnapshotServer, nextSnapshotSocketPath } from "./snapshotServer.js";

/**
 * Build a human label from a CLI hook payload (Claude PostToolUse JSON or our own).
 * @param {Record<string, any>} p
 */
function hookLabel(p) {
    const tool = p.label ?? p.toolName ?? p.tool_name ?? "tool";
    const file = p.filePath ?? p.tool_input?.file_path ?? "";
    return String(file ? `${tool} ${file}` : tool).slice(0, 200);
}

/**
 * @template A
 * @param {Effect.Effect<A, never, any>} effect
 * @returns {Promise<A>}
 */
const runVcs = (effect) => Effect.runPromise(effect.pipe(Effect.provide(getPlatformLayer())));

const NOOP_HANDLE = {
    active: false,
    socketPath: null,
    /** @returns {Promise<{ skipped: true }>} */
    async snapshot() { return { skipped: true }; },
    async stop() { },
};

/**
 * @typedef {object} StartDurabilityOptions
 * @property {boolean} enabled
 * @property {{ upsertWorkspaceState: Function, insertWorkspaceCheckpoint: Function }} adapter
 * @property {string} runId
 * @property {string} nodeId
 * @property {number} [iteration]
 * @property {number} [attempt]
 * @property {string | undefined} cwd
 * @property {() => number} [nowMs]
 * @property {(gap: { request: unknown, reason: string }) => void} [onGap]
 * @property {(cwd: string) => Promise<boolean>} [isJjRepoFn]
 * @property {(cwd: string) => Promise<{ commitId: string, changeId: string, operationId: string } | null>} [captureSnapshot]
 * @property {(deps: { cwd: string, onSettle: () => void }) => { close: () => void, watching?: boolean }} [createWatcher]
 * @property {boolean} [withSocket] When true, open a snapshot socket server so a CLI agent's hook can request strict Tier 1 snapshots.
 * @property {(deps: { runId: string, nodeId: string, snapshot: Function }) => Promise<{ socketPath: string, close: () => void }>} [createSocketServer]
 */

/**
 * @param {StartDurabilityOptions} opts
 * @returns {Promise<{ active: boolean, snapshot: (req?: Record<string, unknown>) => Promise<unknown>, stop: () => Promise<void> }>}
 */
export async function startDurability(opts) {
    const {
        enabled,
        adapter,
        runId,
        nodeId,
        iteration = 0,
        attempt = 0,
        cwd,
        nowMs = () => Date.now(),
        onGap,
        isJjRepoFn = (c) => runVcs(isJjRepo(c)),
        captureSnapshot = (c) => runVcs(captureWorkspaceSnapshot(c)),
        createWatcher = createWorkspaceWatcher,
        withSocket = false,
        createSocketServer = createSnapshotServer,
    } = opts;

    if (!enabled || !cwd) return NOOP_HANDLE;

    let isJj = false;
    try { isJj = await isJjRepoFn(cwd); }
    catch { isJj = false; }
    if (!isJj) return NOOP_HANDLE;

    // Default gaps to a durable spool (outside the worktree) so they survive an
    // engine crash even though the engine passes no onGap. An explicit onGap wins.
    const spoolPath = defaultGapSpoolPath(runId);
    const onGapEffective = onGap ?? ((gap) => appendGap(spoolPath, {
        runId, nodeId, iteration, attempt, cwd, reason: gap.reason, ts: nowMs(),
    }));
    const service = createSnapshotService({ captureSnapshot, adapter, nowMs, onGap: onGapEffective });
    const base = { runId, nodeId, iteration, attempt, cwd };
    /** @param {Record<string, unknown>} req */
    const watchSnapshot = (req) => service.snapshot({ ...base, source: "watch", tier: 2, label: null, toolUseId: null, ...req });
    const watcher = createWatcher({ cwd, onSettle: () => { void watchSnapshot({}); } });

    // Optional Unix-socket server so a CLI agent's PostToolUse hook can request a
    // strict Tier 1 snapshot. Created only when the engine asks (withSocket), so
    // unit tests and the default path never open a real socket.
    let socketServer = null;
    if (withSocket) {
        try {
            socketServer = await createSocketServer({
                socketPath: nextSnapshotSocketPath(),
                onHook: async (payload) => {
                    const result = await service.snapshot({
                        ...base, source: "hook", tier: 1,
                        label: hookLabel(payload),
                        toolUseId: payload.toolUseId ?? payload.tool_use_id ?? null,
                    });
                    return { ok: !(result && result.gap), seq: result && result.seq };
                },
            });
        }
        catch { socketServer = null; }
    }

    return {
        active: true,
        // Socket path for a CLI agent's hook to call back into (null if no socket).
        socketPath: socketServer?.socketPath ?? null,
        // Request a durability snapshot. Defaults to a Tier 2 "watch" snapshot
        // (the debounced filesystem watcher's own writes); the in-process tool
        // wrap and CLI hooks override `source` ("wrap"/"hook"), `tier` (1),
        // `label`, and `toolUseId` via `req`.
        snapshot: (req = {}) => service.snapshot({ ...base, source: "watch", tier: 2, label: null, toolUseId: null, ...req }),
        async stop() {
            watcher.close();
            socketServer?.close();
            // Final flush so the last settled write is captured even if the
            // trailing-idle debounce never fired before the attempt ended.
            await watchSnapshot({});
            // Bound table growth: keep the latest checkpoints/states per scope.
            // Run-scoped + best-effort, so it never affects the run.
            await pruneWorkspaceDurability({ adapter, runId });
        },
    };
}

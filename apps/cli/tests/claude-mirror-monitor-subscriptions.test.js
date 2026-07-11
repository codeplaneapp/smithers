import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readClaudeMirrorSubscriptions } from "../src/claude-mirror/readClaudeMirrorSubscriptions.js";
import { removeClaudeMirrorSubscription } from "../src/claude-mirror/removeClaudeMirrorSubscription.js";
import { resolveClaudeMirrorSubscriptionsPath } from "../src/claude-mirror/resolveClaudeMirrorSubscriptionsPath.js";
import { runClaudeMonitor } from "../src/claude-mirror/runClaudeMonitor.js";
import { upsertClaudeMirrorSubscription } from "../src/claude-mirror/upsertClaudeMirrorSubscription.js";

// The workspace store is shared by every Claude Code session (and by runs no
// session started). The monitor must follow ONLY the runs its session
// subscribed to: the exact regression here is a pre-existing stalled run
// notifying a freshly started session on its first ticks.

const NOW = 1_700_000_000_000;
const STALLED_AFTER_MS = 120_000;

const tempDirs = [];
afterEach(() => {
    while (tempDirs.length) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

function tempWorkspace() {
    const dir = mkdtempSync(join(tmpdir(), "claude-mirror-subs-"));
    tempDirs.push(dir);
    return dir;
}

function writeRegistry(path, subscriptions) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ contract: 1, subscriptions }));
}

function liveEntry(runId, sessionId) {
    return { runId, sessionId, subscribedAtMs: NOW - 1000, expiresAtMs: NOW + 60 * 60 * 1000 };
}

/** @param {Record<string, { status: string; heartbeatAtMs?: number; events?: any[] }>} runsById */
function makeAdapter(runsById, calls = { listRuns: 0 }) {
    return {
        async listRuns() {
            calls.listRuns += 1;
            return Object.entries(runsById).map(([runId, run]) => ({ runId, ...run }));
        },
        async getRun(runId) {
            const run = runsById[runId];
            return run ? { runId, ...run } : undefined;
        },
        async getLastEventSeq() {
            return 0;
        },
        async listEventHistory(runId) {
            return runsById[runId]?.events ?? [];
        },
        async listPendingApprovals() {
            return [];
        },
        async listPendingHumanRequests() {
            return [];
        },
    };
}

async function collectLines(adapter, options) {
    const lines = [];
    await runClaudeMonitor(adapter, {
        ticks: 2,
        intervalMs: 250,
        stalledAfterMs: STALLED_AFTER_MS,
        now: () => NOW,
        write: (line) => lines.push(JSON.parse(line)),
        ...options,
    });
    return lines;
}

describe("runClaudeMonitor subscription scoping", () => {
    test("a pre-existing stalled run the session never subscribed to stays silent", async () => {
        const workspace = tempWorkspace();
        const calls = { listRuns: 0 };
        const adapter = makeAdapter({
            "someone-elses-run": { status: "running", heartbeatAtMs: NOW - STALLED_AFTER_MS - 1000 },
        }, calls);

        const lines = await collectLines(adapter, {
            subscriptionsPath: resolveClaudeMirrorSubscriptionsPath(workspace),
            sessionId: "session-a",
        });

        expect(lines).toEqual([]);
        expect(calls.listRuns).toBe(0);
    });

    test("a subscribed stalled run notifies", async () => {
        const workspace = tempWorkspace();
        const path = resolveClaudeMirrorSubscriptionsPath(workspace);
        upsertClaudeMirrorSubscription(path, { runId: "my-run", sessionId: "session-a", nowMs: NOW });
        const adapter = makeAdapter({
            "my-run": { status: "running", heartbeatAtMs: NOW - STALLED_AFTER_MS - 1000 },
        });

        const lines = await collectLines(adapter, { subscriptionsPath: path, sessionId: "session-a" });

        expect(lines.map((line) => line.kind)).toEqual(["run-stalled"]);
        expect(lines[0].runId).toBe("my-run");
    });

    test("another session's subscription is ignored; a sessionless entry is watched", async () => {
        const workspace = tempWorkspace();
        const path = resolveClaudeMirrorSubscriptionsPath(workspace);
        writeRegistry(path, [liveEntry("their-run", "session-b"), liveEntry("shared-run", null)]);
        const stalled = { status: "running", heartbeatAtMs: NOW - STALLED_AFTER_MS - 1000 };
        const adapter = makeAdapter({ "their-run": stalled, "shared-run": stalled });

        const lines = await collectLines(adapter, { subscriptionsPath: path, sessionId: "session-a" });

        expect(lines.map((line) => [line.kind, line.runId])).toEqual([["run-stalled", "shared-run"]]);
    });

    test("a monitor without a session id watches every live entry, but not expired ones", async () => {
        const workspace = tempWorkspace();
        const path = resolveClaudeMirrorSubscriptionsPath(workspace);
        writeRegistry(path, [
            liveEntry("their-run", "session-b"),
            { runId: "old-run", sessionId: null, subscribedAtMs: NOW - 1000, expiresAtMs: NOW - 1 },
        ]);
        const stalled = { status: "running", heartbeatAtMs: NOW - STALLED_AFTER_MS - 1000 };
        const adapter = makeAdapter({ "their-run": stalled, "old-run": stalled });

        const lines = await collectLines(adapter, { subscriptionsPath: path, sessionId: undefined });

        expect(lines.map((line) => [line.kind, line.runId])).toEqual([["run-stalled", "their-run"]]);
    });

    test("a subscribed run that turns terminal emits its failure once and is pruned", async () => {
        const workspace = tempWorkspace();
        const path = resolveClaudeMirrorSubscriptionsPath(workspace);
        upsertClaudeMirrorSubscription(path, { runId: "my-run", sessionId: "session-a", nowMs: NOW });
        // Flips terminal after the first-sight read, like a real run failing
        // between polls.
        let status = "running";
        const adapter = {
            async getRun(runId) {
                if (runId !== "my-run") return undefined;
                const run = { runId, status, heartbeatAtMs: NOW };
                status = "failed";
                return run;
            },
            async getLastEventSeq() {
                return 0;
            },
            async listEventHistory() {
                return status === "failed" ? [{ seq: 1, type: "RunFailed", payloadJson: "{}" }] : [];
            },
            async listPendingApprovals() {
                return [];
            },
            async listPendingHumanRequests() {
                return [];
            },
        };
        const lines = [];
        await runClaudeMonitor(adapter, {
            ticks: 3,
            intervalMs: 250,
            stalledAfterMs: STALLED_AFTER_MS,
            now: () => NOW,
            write: (line) => lines.push(JSON.parse(line)),
            subscriptionsPath: path,
            sessionId: "session-a",
        });

        expect(lines.map((line) => line.kind)).toEqual(["run-failed"]);
        expect(readClaudeMirrorSubscriptions(path, NOW)).toEqual([]);
    });

    test("a run already terminal on first sight stays silent and is pruned", async () => {
        const workspace = tempWorkspace();
        const path = resolveClaudeMirrorSubscriptionsPath(workspace);
        upsertClaudeMirrorSubscription(path, { runId: "old-run", sessionId: "session-a", nowMs: NOW });
        const adapter = makeAdapter({
            "old-run": { status: "failed", events: [{ seq: 1, type: "RunFailed", payloadJson: "{}" }] },
        });

        const lines = await collectLines(adapter, { subscriptionsPath: path, sessionId: "session-a" });

        expect(lines).toEqual([]);
        expect(readClaudeMirrorSubscriptions(path, NOW)).toEqual([]);
    });
});

describe("claude-mirror subscription registry helpers", () => {
    test("upsert creates the registry, refresh preserves subscribedAtMs and extends expiry", () => {
        const workspace = tempWorkspace();
        const path = resolveClaudeMirrorSubscriptionsPath(workspace);
        expect(existsSync(path)).toBe(false);

        expect(upsertClaudeMirrorSubscription(path, { runId: "run-1", sessionId: "s1", nowMs: NOW })).toBe(true);
        const first = readClaudeMirrorSubscriptions(path, NOW)[0];
        expect(first).toMatchObject({ runId: "run-1", sessionId: "s1", subscribedAtMs: NOW });

        upsertClaudeMirrorSubscription(path, { runId: "run-1", sessionId: "s1", nowMs: NOW + 5000 });
        const refreshed = readClaudeMirrorSubscriptions(path, NOW);
        expect(refreshed).toHaveLength(1);
        expect(refreshed[0].subscribedAtMs).toBe(NOW);
        expect(refreshed[0].expiresAtMs).toBe(first.expiresAtMs + 5000);
    });

    test("entries are keyed by (runId, sessionId); remove scopes to a session or drops all", () => {
        const workspace = tempWorkspace();
        const path = resolveClaudeMirrorSubscriptionsPath(workspace);
        upsertClaudeMirrorSubscription(path, { runId: "run-1", sessionId: "s1", nowMs: NOW });
        upsertClaudeMirrorSubscription(path, { runId: "run-1", sessionId: "s2", nowMs: NOW });
        upsertClaudeMirrorSubscription(path, { runId: "run-2", sessionId: "s1", nowMs: NOW });
        expect(readClaudeMirrorSubscriptions(path, NOW)).toHaveLength(3);

        expect(removeClaudeMirrorSubscription(path, { runId: "run-1", sessionId: "s1", nowMs: NOW })).toBe(true);
        expect(readClaudeMirrorSubscriptions(path, NOW).map((entry) => [entry.runId, entry.sessionId])).toEqual([
            ["run-1", "s2"],
            ["run-2", "s1"],
        ]);

        expect(removeClaudeMirrorSubscription(path, { runId: "run-1", nowMs: NOW })).toBe(true);
        expect(readClaudeMirrorSubscriptions(path, NOW).map((entry) => entry.runId)).toEqual(["run-2"]);

        expect(removeClaudeMirrorSubscription(path, { runId: "missing", nowMs: NOW })).toBe(false);
    });

    test("a corrupt registry reads as empty and upsert recovers it", () => {
        const workspace = tempWorkspace();
        const path = resolveClaudeMirrorSubscriptionsPath(workspace);
        upsertClaudeMirrorSubscription(path, { runId: "run-1", sessionId: "s1", nowMs: NOW });
        writeFileSync(path, "{not json");

        expect(readClaudeMirrorSubscriptions(path, NOW)).toEqual([]);
        expect(removeClaudeMirrorSubscription(path, { runId: "run-1" })).toBe(false);
        expect(upsertClaudeMirrorSubscription(path, { runId: "run-2", sessionId: "s1", nowMs: NOW })).toBe(true);
        expect(readClaudeMirrorSubscriptions(path, NOW).map((entry) => entry.runId)).toEqual(["run-2"]);
        expect(JSON.parse(readFileSync(path, "utf8")).contract).toBe(1);
    });
});

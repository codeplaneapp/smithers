// Concurrency tests for the rewind single-flight lock used by jumpToFrame.
//
// What the lock IS (see packages/time-travel/src/rewindLockStore.js,
// acquireRewindLock.js):
//   - Process-local in-memory `Map<runId, symbol>`.
//   - `acquireRewindLock(runId)` returns null if another rewind is in flight,
//     otherwise returns a handle whose `release()` is idempotent.
//   - On crash, the in-memory Map dies with the process and the lock is
//     implicitly released. Recovery of in-flight audit ROWS in the DB is a
//     separate startup-time mechanism (recoverInProgressRewindAudits).
//
// What the lock is NOT:
//   - There is no per-lock TTL or wall-clock timeout. A long-running rewind
//     in process P keeps the lock until release; another in-process attempt
//     does NOT wait, it returns null immediately ("Busy"). See the existing
//     rewindLock.test.ts for the basic single-process semantics.
//
// FIXME(latent bug / unimplemented feature): "Lock held by crashed process,
// recovered after timeout" cannot be tested at the `acquireRewindLock` layer
// because the lock map is per-process. The closest analogue — startup
// reconciliation of `in_progress` audit rows after a crash — already has
// coverage in `recoverInProgressRewindAudits.test.ts`. The relevant test is
// kept here as `.skip` documenting the gap.
import { afterEach, describe, expect, test } from "bun:test";
import {
	acquireRewindLock,
	hasRewindLock,
	resetRewindLocksForTests,
} from "../src/rewindLock.js";

afterEach(() => {
	resetRewindLocksForTests();
});

describe("rewindLock concurrency", () => {
	test("two parallel acquisitions on same runId: exactly one wins, the other gets null (busy)", async () => {
		const runId = "run-parallel";
		// Kick off two acquisition attempts in microtask-overlapping order.
		const results = await Promise.all([
			Promise.resolve().then(() => acquireRewindLock(runId)),
			Promise.resolve().then(() => acquireRewindLock(runId)),
		]);
		const wins = results.filter((r) => r !== null);
		const losses = results.filter((r) => r === null);
		expect(wins.length).toBe(1);
		expect(losses.length).toBe(1);
		expect(wins[0]?.release()).toBe(true);
		expect(hasRewindLock(runId)).toBe(false);
	});

	test("invariant under N parallel attempts: exactly one acquirer at a time", async () => {
		const runId = "run-N";
		const N = 50;
		const attempts = await Promise.all(
			Array.from({ length: N }, () =>
				Promise.resolve().then(() => acquireRewindLock(runId)),
			),
		);
		const winners = attempts.filter((a) => a !== null);
		expect(winners.length).toBe(1);
		expect(attempts.filter((a) => a === null).length).toBe(N - 1);
		winners[0]?.release();
		// After release, a fresh acquire succeeds.
		const post = acquireRewindLock(runId);
		expect(post).not.toBeNull();
		post?.release();
	});

	test("two rewinds on the SAME run: the busy one rejects (does not wait)", async () => {
		// Mirrors what jumpToFrame does in src/jumpToFrame.js:520 — a busy
		// acquire is reported as a JumpToFrameError("Busy"), not a wait.
		const runId = "run-busy-reject";
		const first = acquireRewindLock(runId);
		expect(first).not.toBeNull();

		const trySecond = () => {
			const handle = acquireRewindLock(runId);
			if (!handle) throw new Error("Busy");
			return handle;
		};
		expect(() => trySecond()).toThrow("Busy");
		first?.release();
		// After release the second-style attempt now succeeds.
		const second = trySecond();
		second.release();
	});

	test("two rewinds on DIFFERENT runs proceed in parallel without contention", async () => {
		const ids = ["run-x", "run-y", "run-z"];
		const handles = ids.map((id) => acquireRewindLock(id));
		expect(handles.every((h) => h !== null)).toBe(true);
		for (const id of ids) expect(hasRewindLock(id)).toBe(true);
		for (const h of handles) h?.release();
		for (const id of ids) expect(hasRewindLock(id)).toBe(false);
	});

	test("simulated 'one rewind times out' — caller releases on timeout, next acquire proceeds", async () => {
		// The lock has no built-in timeout, but callers (jumpToFrame) wrap
		// the work in their own deadline and release the handle in a finally
		// block. We model that behaviour here: an in-flight rewind is
		// abandoned via a caller-side timeout, lock is released, the next
		// rewind proceeds.
		const runId = "run-timeout";
		const lock = acquireRewindLock(runId);
		expect(lock).not.toBeNull();

		// Caller-side timeout race.
		const work = new Promise((resolve) => setTimeout(resolve, 200));
		const deadline = new Promise((_resolve, reject) =>
			setTimeout(() => reject(new Error("rewind deadline exceeded")), 20),
		);
		try {
			await Promise.race([work, deadline]);
		} catch (err) {
			expect(String(err)).toContain("deadline exceeded");
		} finally {
			lock?.release();
		}
		expect(hasRewindLock(runId)).toBe(false);
		const next = acquireRewindLock(runId);
		expect(next).not.toBeNull();
		next?.release();
	});

	test("interleaved acquire/release across two runs is independent", async () => {
		// Verify that releasing run A does not interfere with the lock state
		// of run B, even when their lifetimes overlap.
		const a = acquireRewindLock("A");
		const b = acquireRewindLock("B");
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		a?.release();
		expect(hasRewindLock("A")).toBe(false);
		expect(hasRewindLock("B")).toBe(true);
		const a2 = acquireRewindLock("A");
		expect(a2).not.toBeNull();
		// B still held.
		expect(acquireRewindLock("B")).toBeNull();
		b?.release();
		a2?.release();
	});

	// FIXME(unimplemented feature): Lock held by crashed PROCESS recovered
	// after timeout. The current rewindLockStore is in-memory, so a crash
	// implicitly clears it for the new process. There's no cross-process
	// lock and no timeout-based recovery. Promote when (a) the lock moves to
	// the DB and (b) a `lockExpiresAtMs` column / heartbeat is introduced.
	test.skip("lock held by crashed process recovered after timeout", () => {
		// Not implementable against the current in-memory rewindLockStore.
		// See file-top FIXME.
	});
});

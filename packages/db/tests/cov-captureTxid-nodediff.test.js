import { describe, expect, test } from "bun:test";
import {
  isRealPostgresAdapter,
  createTxidCapture,
  runWithTxidCapture,
  hasActiveTxidCapture,
  shouldCapturePostgresTxid,
  capturePostgresTransactionTxid,
  recordCommittedTxid,
  captureTxid,
} from "../src/captureTxid.js";
import { NodeDiffTooLargeError, NODE_DIFF_MAX_BYTES } from "../src/cache/nodeDiffCache.js";

/**
 * Build a fake SmithersDb-shaped adapter whose internalStorage answers the two
 * raw probes captureTxid issues (`version()` and `pg_current_xact_id()`). This
 * is a real object exercising the real code path — no library is mocked.
 */
function makeAdapter({ dialect = "postgres", version = "PostgreSQL 16.1", txid = "12345", queryOneRaw } = {}) {
  let versionCalls = 0;
  const storage = {
    dialect,
    queryOneRaw:
      queryOneRaw ??
      (async (statement) => {
        if (statement.includes("version()")) {
          versionCalls += 1;
          return { version };
        }
        if (statement.includes("pg_current_xact_id")) {
          return { txid };
        }
        return undefined;
      }),
  };
  return {
    adapter: { internalStorage: storage },
    get versionCalls() {
      return versionCalls;
    },
  };
}

describe("captureTxid — real-postgres detection", () => {
  test("returns false for missing storage / wrong dialect / no queryOneRaw", async () => {
    expect(await isRealPostgresAdapter({})).toBe(false);
    expect(await isRealPostgresAdapter({ internalStorage: { dialect: "sqlite" } })).toBe(false);
    expect(await isRealPostgresAdapter({ internalStorage: { dialect: "postgres" } })).toBe(false);
  });

  test("classifies a real PostgreSQL version as real and caches the probe", async () => {
    const h = makeAdapter({ version: "PostgreSQL 16.1 on x86_64" });
    expect(await isRealPostgresAdapter(h.adapter)).toBe(true);
    expect(await isRealPostgresAdapter(h.adapter)).toBe(true);
    expect(h.versionCalls).toBe(1); // cached on the storage object
  });

  test("classifies a PGlite version as NOT real postgres", async () => {
    const h = makeAdapter({ version: "PGlite 0.2 (PostgreSQL 16.0)" });
    expect(await isRealPostgresAdapter(h.adapter)).toBe(false);
  });
});

describe("captureTxid — active-capture scoping", () => {
  test("hasActiveTxidCapture is true only inside runWithTxidCapture for the matching adapter", async () => {
    const adapter = {};
    const capture = createTxidCapture(adapter);
    expect(hasActiveTxidCapture(adapter)).toBe(false);
    await runWithTxidCapture(capture, async () => {
      expect(hasActiveTxidCapture(adapter)).toBe(true);
      expect(hasActiveTxidCapture({})).toBe(false); // different adapter
    });
    expect(hasActiveTxidCapture(adapter)).toBe(false);
  });

  test("shouldCapturePostgresTxid gates on both an active capture and a real postgres backend", async () => {
    const realH = makeAdapter({ version: "PostgreSQL 16.1" });
    const capture = createTxidCapture(realH.adapter);
    // No active capture → false.
    expect(await shouldCapturePostgresTxid(realH.adapter)).toBe(false);
    await runWithTxidCapture(capture, async () => {
      expect(await shouldCapturePostgresTxid(realH.adapter)).toBe(true);
    });
    // Active capture but pglite backend → false.
    const pgliteH = makeAdapter({ version: "PGlite 0.2" });
    const pgliteCapture = createTxidCapture(pgliteH.adapter);
    await runWithTxidCapture(pgliteCapture, async () => {
      expect(await shouldCapturePostgresTxid(pgliteH.adapter)).toBe(false);
    });
  });
});

describe("captureTxid — capturePostgresTransactionTxid", () => {
  test("returns null for non-postgres / non-real / non-numeric txid, and the numeric txid otherwise", async () => {
    expect(await capturePostgresTransactionTxid({})).toBeNull();
    expect(await capturePostgresTransactionTxid({ internalStorage: { dialect: "sqlite" } })).toBeNull();
    expect(await capturePostgresTransactionTxid(makeAdapter({ version: "PGlite 0.2" }).adapter)).toBeNull();

    const real = makeAdapter({ version: "PostgreSQL 16.1", txid: "999" });
    expect(await capturePostgresTransactionTxid(real.adapter)).toBe("999");

    const nonNumeric = makeAdapter({ version: "PostgreSQL 16.1", txid: "not-a-number" });
    expect(await capturePostgresTransactionTxid(nonNumeric.adapter)).toBeNull();
  });
});

describe("captureTxid — record + await", () => {
  test("captureTxid rejects a non-capture and returns an already-recorded txid immediately", async () => {
    expect(await captureTxid({})).toBeNull();
    const capture = createTxidCapture({});
    capture.txid = "77";
    expect(await captureTxid(capture)).toBe("77");
  });

  test("captureTxid with waitMs<=0 and no txid returns null immediately", async () => {
    const capture = createTxidCapture({});
    expect(await captureTxid(capture, { waitMs: 0 })).toBeNull();
  });

  test("a committing writer resolves a waiting captureTxid", async () => {
    const adapter = {};
    const capture = createTxidCapture(adapter);
    await runWithTxidCapture(capture, async () => {
      const pending = captureTxid(capture, { waitMs: 1000 });
      // Non-numeric record is ignored; the numeric one resolves the waiter.
      recordCommittedTxid(adapter, "not-numeric");
      recordCommittedTxid(adapter, "42");
      expect(await pending).toBe("42");
      // A second record is a no-op (txid already set).
      recordCommittedTxid(adapter, "43");
      expect(capture.txid).toBe("42");
    });
  });

  test("captureTxid times out to null when no txid is committed", async () => {
    const capture = createTxidCapture({});
    expect(await captureTxid(capture, { waitMs: 15 })).toBeNull();
  });
});

describe("NodeDiffTooLargeError", () => {
  test("carries the DiffTooLarge code and the offending byte size", () => {
    const err = new NodeDiffTooLargeError(NODE_DIFF_MAX_BYTES + 1);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NodeDiffTooLargeError");
    expect(err.code).toBe("DiffTooLarge");
    expect(err.sizeBytes).toBe(NODE_DIFF_MAX_BYTES + 1);
    expect(err.message).toContain(String(NODE_DIFF_MAX_BYTES));
  });
});

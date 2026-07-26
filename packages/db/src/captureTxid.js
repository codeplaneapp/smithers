import { AsyncLocalStorage } from "node:async_hooks";
import { POSTGRES } from "./dialect.js";

const PGLITE_VERSION_PATTERN = /\bPGlite\b/i;
const TXID_CAPTURE_MARKER = Symbol("smithers.txidCapture");
/** @type {WeakMap<object, boolean>} */
const realPostgresCache = new WeakMap();
/** @type {AsyncLocalStorage<Record<string | symbol, unknown>>} */
const txidCaptureStorage = new AsyncLocalStorage();

/** @typedef {{ [TXID_CAPTURE_MARKER]: true; adapter: object; txid: string | null; waiters: Set<(txid: string | null) => void> }} TxidCapture */

/**
 * @param {unknown} value
 * @returns {value is TxidCapture}
 */
function isTxidCapture(value) {
  return Boolean(value && typeof value === "object" && value[TXID_CAPTURE_MARKER] === true);
}

/**
 * @param {unknown} txid
 * @returns {txid is string}
 */
function isNumericTxid(txid) {
  return typeof txid === "string" && /^\d+$/.test(txid);
}

/**
 * @param {{ internalStorage?: { dialect?: string; queryOneRaw?: (statement: string, params?: readonly unknown[]) => Promise<Record<string, unknown> | undefined> } }} adapter
 * @returns {Promise<boolean>}
 */
export async function isRealPostgresAdapter(adapter) {
  const storage = adapter?.internalStorage;
  if (!storage || storage.dialect !== POSTGRES || typeof storage.queryOneRaw !== "function") {
    return false;
  }
  const storageKey = /** @type {object} */ (storage);
  const cached = realPostgresCache.get(storageKey);
  if (cached !== undefined) {
    return cached;
  }
  const versionRow = await storage.queryOneRaw("SELECT version() AS version");
  const version = typeof versionRow?.version === "string" ? versionRow.version : "";
  const realPostgres = !PGLITE_VERSION_PATTERN.test(version);
  realPostgresCache.set(storageKey, realPostgres);
  return realPostgres;
}

/**
 * @param {object} adapter
 * @returns {TxidCapture}
 */
export function createTxidCapture(adapter) {
  return {
    [TXID_CAPTURE_MARKER]: true,
    adapter,
    txid: null,
    waiters: new Set(),
  };
}

/**
 * @template T
 * @param {TxidCapture} capture
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runWithTxidCapture(capture, fn) {
  return txidCaptureStorage.run(capture, fn);
}

/**
 * @param {object} adapter
 * @returns {boolean}
 */
export function hasActiveTxidCapture(adapter) {
  const capture = txidCaptureStorage.getStore();
  return isTxidCapture(capture) && capture.adapter === adapter;
}

/**
 * @param {{ internalStorage?: { dialect?: string; queryOneRaw?: (statement: string, params?: readonly unknown[]) => Promise<Record<string, unknown> | undefined> } }} adapter
 * @returns {Promise<boolean>}
 */
export async function shouldCapturePostgresTxid(adapter) {
  if (!hasActiveTxidCapture(/** @type {object} */ (adapter))) {
    return false;
  }
  return isRealPostgresAdapter(adapter);
}

/**
 * Capture the current PostgreSQL transaction id as text when the adapter is
 * backed by a real Postgres connection. This must be called before COMMIT on
 * the same transaction that performed the mutation.
 *
 * @param {{ internalStorage?: { dialect?: string; queryOneRaw?: (statement: string, params?: readonly unknown[]) => Promise<Record<string, unknown> | undefined> } }} adapter
 * @returns {Promise<string | null>}
 */
export async function capturePostgresTransactionTxid(adapter) {
  const storage = adapter?.internalStorage;
  if (!storage || storage.dialect !== POSTGRES || typeof storage.queryOneRaw !== "function") {
    return null;
  }
  if (!(await isRealPostgresAdapter(adapter))) {
    return null;
  }
  const row = await storage.queryOneRaw("SELECT pg_current_xact_id()::xid::text AS txid");
  const txid = typeof row?.txid === "string" ? row.txid : null;
  return isNumericTxid(txid) ? txid : null;
}

/**
 * @param {object} adapter
 * @param {string | null} txid
 */
export function recordCommittedTxid(adapter, txid) {
  if (!isNumericTxid(txid)) {
    return;
  }
  const capture = txidCaptureStorage.getStore();
  if (!isTxidCapture(capture) || capture.adapter !== adapter || capture.txid !== null) {
    return;
  }
  capture.txid = txid;
  for (const resolve of capture.waiters) {
    resolve(txid);
  }
  capture.waiters.clear();
}

/**
 * Return a request-scoped transaction id that was already captured inside the
 * committing transaction. This function deliberately has no SQL fallback.
 *
 * @param {unknown} capture
 * @param {{ waitMs?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function captureTxid(capture, options = {}) {
  if (!isTxidCapture(capture)) {
    return null;
  }
  if (isNumericTxid(capture.txid)) {
    return capture.txid;
  }
  const waitMs = options.waitMs ?? 0;
  if (waitMs <= 0) {
    return null;
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      capture.waiters.delete(waiter);
      resolve(null);
    }, waitMs);
    const waiter = (txid) => {
      clearTimeout(timer);
      resolve(txid);
    };
    capture.waiters.add(waiter);
  });
}

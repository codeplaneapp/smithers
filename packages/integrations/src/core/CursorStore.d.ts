import { CursorStore as CursorStore$1 } from './CursorStoreTypes.js';
import * as _smthrs_db_adapter from '@smthrs/db/adapter';
import 'effect';
import '@smthrs/errors/SmithersError';

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/**
 * CursorStore backed by the db adapter's `_smithers_integration_cursors`
 * table, so a polling source survives process restarts.
 * @param {SmithersDb} adapter
 * @returns {CursorStore}
 */
declare function makeDbCursorStore(adapter: SmithersDb): CursorStore;
/**
 * In-memory CursorStore (tests / ephemeral sources).
 * @returns {CursorStore}
 */
declare function makeInMemoryCursorStore(): CursorStore;
type SmithersDb = _smthrs_db_adapter.SmithersDb;
type CursorStore = CursorStore$1;

export { type CursorStore, type SmithersDb, makeDbCursorStore, makeInMemoryCursorStore };

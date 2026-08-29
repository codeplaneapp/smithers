/**
 * Structural view of the Cloudflare Durable Object storage API.
 *
 * `DurableObjectDatabase` is typed against these interfaces rather than
 * against `@cloudflare/workers-types`, the way `@smthrs/platform-browser`
 * types `BrowserFileSystem` against `ZenFsPromisesLike` instead of ZenFS. The
 * driver needs four members of a surface that spans thousands of lines of
 * ambient declarations, and depending on the full package would put a
 * workers-only global namespace in the type graph of a package that also
 * builds for Node and the browser. A real `DurableObjectStorage` satisfies
 * these interfaces structurally, so `ctx.storage` passes with no cast.
 *
 * The declarations track `@cloudflare/workers-types` 5.20260814.1, the version
 * `@smthrs/build-infra` already pins.
 *
 * @since 0.1.0
 */

/**
 * The value types Durable Object SQLite reads out of a column.
 *
 * `exec` hands back `ArrayBuffer` for a SQLite blob; the driver normalizes
 * that to `Uint8Array` so rows look the same as they do on `node:sqlite`.
 *
 * @category models
 * @since 0.1.0
 */
export type SqlStorageValue = ArrayBuffer | string | number | null

/**
 * The cursor `SqlStorage.exec` returns.
 *
 * Only the positional `raw()` iterator and `columnNames` are used. Reading
 * rows positionally and rebuilding each object against `columnNames` keeps
 * duplicate column labels from collapsing, which the object cursor would do.
 *
 * @category models
 * @since 0.1.0
 */
export interface SqlStorageCursorLike {
  readonly columnNames: ReadonlyArray<string>
  raw(): IterableIterator<Array<SqlStorageValue>>
}

/**
 * The Durable Object SQLite handle, `ctx.storage.sql`.
 *
 * `exec` is synchronous: the statement runs to completion on the calling
 * thread and the cursor iterates an in-memory result. That is what lets the
 * driver build its whole connection out of `Effect.try` with no promise
 * anywhere.
 *
 * @category models
 * @since 0.1.0
 */
export interface SqlStorageLike {
  exec(query: string, ...bindings: ReadonlyArray<unknown>): SqlStorageCursorLike
}

/**
 * The transaction handle passed to `DurableObjectStorage.transaction`.
 *
 * @category models
 * @since 0.1.0
 */
export interface DurableObjectTransactionLike {
  rollback(): void
}

/**
 * The Durable Object storage handle, `ctx.storage`.
 *
 * The driver takes the whole storage rather than just `sql` because Durable
 * Object SQLite refuses transaction-control statements through `exec`:
 * `BEGIN`, `COMMIT`, and `ROLLBACK` are the platform's to issue, and
 * `transaction` is the only way to ask for them.
 *
 * @category models
 * @since 0.1.0
 */
export interface DurableObjectStorageLike {
  readonly sql: SqlStorageLike
  transaction<A>(closure: (transaction: DurableObjectTransactionLike) => Promise<A>): Promise<A>
}

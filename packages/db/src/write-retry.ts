import type { SqliteWriteRetryOptions } from "./SqliteWriteRetryOptions";
export type { SqliteWriteRetryOptions } from "./SqliteWriteRetryOptions";
export { isRetryableSqliteWriteError } from "./isRetryableSqliteWriteError";
export { withSqliteWriteRetryEffect } from "./withSqliteWriteRetryEffect";
export declare function withSqliteWriteRetry<A>(operation: () => A | PromiseLike<A>, opts?: SqliteWriteRetryOptions): Promise<A>;

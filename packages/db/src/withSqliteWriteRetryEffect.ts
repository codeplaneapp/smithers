import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { SqliteWriteRetryOptions } from "./SqliteWriteRetryOptions";
export declare function withSqliteWriteRetryEffect<A>(operation: () => Effect.Effect<A, SmithersError>, opts?: SqliteWriteRetryOptions): Effect.Effect<A, SmithersError>;

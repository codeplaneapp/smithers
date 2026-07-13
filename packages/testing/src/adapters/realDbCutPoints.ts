import { Effect } from "effect";
import type { RealDbResource } from "./realDbAdapter.ts";

type Awaitable<T> = T | Promise<T> | Effect.Effect<T, unknown>;
const resolve = async <T>(value: Awaitable<T>): Promise<T> => {
  if (value && typeof (value as { pipe?: unknown }).pipe === "function") return Effect.runPromise(value as Effect.Effect<T, unknown>);
  return await value as T;
};

/**
 * Bind the framework's durability vocabulary to SmithersDb's production CAS
 * methods.  These bindings are deliberately boring: a real-db proof must
 * call the methods on the admitted SmithersDb instance, never a journal echo.
 */
export const realDbCutPoints = (db: RealDbResource) => Object.freeze({
  claimAttemptCompletion: (...args: Parameters<RealDbResource["claimAttemptCompletion"]>) => resolve(db.claimAttemptCompletion(...args)),
  claimRunForResume: (...args: Parameters<RealDbResource["claimRunForResume"]>) => resolve(db.claimRunForResume(...args)),
  heartbeatRun: (...args: Parameters<RealDbResource["heartbeatRun"]>) => resolve(db.heartbeatRun(...args)),
  completeRun: (...args: Parameters<RealDbResource["completeRun"]>) => resolve(db.completeRun(...args)),
  requestRunCancel: (...args: Parameters<RealDbResource["requestRunCancel"]>) => resolve(db.requestRunCancel(...args)),
  claimRunCancellation: (...args: Parameters<RealDbResource["claimRunCancellation"]>) => resolve(db.claimRunCancellation(...args)),
  heartbeatAttempt: (...args: Parameters<RealDbResource["heartbeatAttempt"]>) => resolve(db.heartbeatAttempt(...args)),
});

import type { RealDbResource } from "./realDbAdapter.ts";

type Awaitable<T> = T | PromiseLike<T>;
const preserve = <T>(value: T | PromiseLike<T>): Awaitable<T> => value;
const invoke = (receiver: object, method: unknown, args: readonly unknown[]): unknown =>
  typeof method === "function"
    ? (method as (...values: readonly unknown[]) => unknown).apply(receiver, [...args])
    : undefined;

export type ClaimAttemptCompletionInput = Readonly<{
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  runtimeOwnerId: string | null;
  finishedAtMs: number;
}>;
export type ClaimRunForResumeInput = Readonly<{
  runId: string;
  expectedStatus?: string;
  expectedRuntimeOwnerId: string | null;
  expectedHeartbeatAtMs: number | null;
  staleBeforeMs: number;
  claimOwnerId: string;
  claimHeartbeatAtMs: number;
  requireStale?: boolean;
}>;
export type HeartbeatRunInput = Readonly<{ runId: string; runtimeOwnerId: string; heartbeatAtMs: number }>;
export type RealDbOperationMap = Readonly<{
  claimAttemptCompletion: (input: ClaimAttemptCompletionInput) => Awaitable<boolean>;
  claimRunForResume: (input: ClaimRunForResumeInput) => Awaitable<boolean>;
  heartbeatRun: (input: HeartbeatRunInput) => Awaitable<void>;
  completeRun: (input: Readonly<{ runId: string; runtimeOwnerId: string; finishedAtMs: number }>) => Awaitable<unknown>;
  requestRunCancel: (input: Readonly<{ runId: string; cancelRequestedAtMs: number }>) => Awaitable<unknown>;
  claimRunCancellation: (
    input: Readonly<{ runId: string; cancelledAtMs: number; errorJson?: string | null }>,
  ) => Awaitable<unknown>;
}>;

/**
 * Bind the framework's durability vocabulary to SmithersDb's production CAS
 * methods.  These bindings are deliberately boring: a real-db proof must
 * call the methods on the admitted SmithersDb instance, never a journal echo.
 */
export const realDbCutPoints = (db: RealDbResource): RealDbOperationMap =>
  Object.freeze({
    claimAttemptCompletion: (input) =>
      preserve(
        invoke(db, db.claimAttemptCompletion, [
          input.runId,
          input.nodeId,
          input.iteration,
          input.attempt,
          input.runtimeOwnerId,
          input.finishedAtMs,
        ]) as boolean | PromiseLike<boolean>,
      ),
    claimRunForResume: (input) => preserve(invoke(db, db.claimRunForResume, [input]) as boolean | PromiseLike<boolean>),
    heartbeatRun: (input) =>
      preserve(
        invoke(db, db.heartbeatRun, [
          input.runId,
          input.runtimeOwnerId,
          input.heartbeatAtMs,
        ]) as void | PromiseLike<void>,
      ),
    completeRun: (input) =>
      preserve(
        invoke(db, db.completeRun, [
          input.runId,
          input.runtimeOwnerId,
          input.finishedAtMs,
        ]) as unknown as PromiseLike<unknown>,
      ),
    requestRunCancel: (input) =>
      preserve(
        invoke(db, db.requestRunCancel, [input.runId, input.cancelRequestedAtMs]) as unknown as PromiseLike<unknown>,
      ),
    claimRunCancellation: (input) =>
      preserve(
        invoke(db, db.claimRunCancellation, [
          input.runId,
          input.cancelledAtMs,
          input.errorJson,
        ]) as unknown as PromiseLike<unknown>,
      ),
  });

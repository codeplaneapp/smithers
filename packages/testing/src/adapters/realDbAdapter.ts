import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { registerTrustedAdapter, type AdapterFaultContext, type HarnessAdapter } from "../harness/Harness.ts";
import { realDbCutPoints } from "./realDbCutPoints.ts";
import { existsSync } from "node:fs";

// `SmithersDb` exposes RunnableEffect values (callables and PromiseLike).  The
// resource surface deliberately erases that implementation detail, while
// `never[]` keeps strict function variance from rejecting narrower production
// methods such as insertRun(row).
type PlainDbMethod = (...args: readonly never[]) => unknown | PromiseLike<unknown>;
type DbMethod<Args extends readonly unknown[]> = (...args: Args) => unknown | PromiseLike<unknown>;
type AttemptCompletionArgs = [runId: string, nodeId: string, iteration: number, attempt: number, runtimeOwnerId: string | null, finishedAtMs: number];
type ResumeArgs = [params: { runId: string; expectedStatus?: string; expectedRuntimeOwnerId: string | null; expectedHeartbeatAtMs: number | null; staleBeforeMs: number; claimOwnerId: string; claimHeartbeatAtMs: number; requireStale?: boolean }];
type HeartbeatAttemptArgs = [runId: string, nodeId: string, iteration: number, attempt: number, heartbeatAtMs: number, heartbeatDataJson: string | null, runtimeOwnerId: string | null];
export type RealDbResource = Readonly<{
  readonly db: unknown; readonly path?: string; readonly productionIdentity?: "SmithersDb"; readonly close: () => void | Promise<void>;
  readonly insertRun: PlainDbMethod; readonly heartbeatRun: DbMethod<[runId: string, runtimeOwnerId: string, heartbeatAtMs: number]>; readonly listRuns: PlainDbMethod;
  readonly claimAttemptCompletion?: DbMethod<AttemptCompletionArgs>; readonly claimRunForResume?: DbMethod<ResumeArgs>; readonly completeRun?: DbMethod<[runId: string, runtimeOwnerId: string, finishedAtMs: number]>;
  readonly requestRunCancel?: DbMethod<[runId: string, cancelRequestedAtMs: number]>; readonly claimRunCancellation?: DbMethod<[runId: string, cancelledAtMs: number, errorJson?: string | null]>;
  // Production methods are intentionally represented as callable resources at
  // this boundary. Their exact argument contracts are enforced by the typed
  // operation map in runStep, while this broad shape also accepts a real
  // SmithersDb instance whose RunnableEffect methods use strict variance.
  readonly heartbeatAttempt?: PlainDbMethod; readonly operations?: Readonly<Record<string, PlainDbMethod>>
}>;
export type RealDbAdapterOptions = Readonly<{ readonly open: () => RealDbResource | Promise<RealDbResource>; readonly identity?: string; readonly serializeError?: HarnessAdapter["serializeError"]; readonly extensionExecutors?: HarnessAdapter["extensionExecutors"] }>;

export const realDbAdapter = (options: RealDbAdapterOptions): HarnessAdapter => {
  const productionOperations = new Set(["claimAttemptCompletion", "claimRunForResume", "heartbeatRun", "completeRun", "requestRunCancel", "claimRunCancellation", "heartbeatAttempt"]);
  let resource: RealDbResource | undefined;
  const runDb = async <T>(value: T | Promise<T>): Promise<T> => {
    if (value && typeof (value as unknown as { then?: unknown }).then === "function") return await value;
    return value as T;
  };
  // Advertise ONLY the cut points this adapter can execute at a production
  // SmithersDb transition (claimAttemptCompletion/completeRun ↦
  // completion-cas, claimRunForResume ↦ resume, heartbeatRun ↦ heartbeat,
  // requestRunCancel/claimRunCancellation ↦ cancellation).
  // heartbeat:during-task executes a REAL claimRunForResume takeover whose
  // fencing rejects the old owner's production heartbeat, and
  // cancellation:during-task executes the REAL completion CAS against the
  // committed cancel request; both outcomes are read back from durable state
  // in injectFault. A free-standing `lease:*` operation has no production
  // seam of its own here, so it is deliberately absent and fails admission
  // instead of degrading to simulation.
  const executableCutPoints = new Set([
    "completion-cas:before-task", "completion-cas:after-task", "completion-cas:after-journal-before-ack",
    "resume:before-task", "heartbeat:during-task", "cancellation:during-task",
  ]);
  return registerTrustedAdapter({
    identity: options.identity ?? "real-db:sqlite",
    verifiedProductionIdentity: "@smithers-orchestrator/db/adapter:SmithersDb",
    supportedCutPoints: executableCutPoints,
    admissionProbe: async () => {
      resource = await options.open();
      if (!(resource instanceof SmithersDb) || !resource.db || typeof resource.insertRun !== "function" || typeof resource.heartbeatRun !== "function" || typeof resource.close !== "function") {
        throw Object.assign(new Error("real-db adapter requires a live SmithersDb backed by Bun SQLite; declarations and echo objects are not proof"), { code: "ADMISSION_FAILED" });
      }
      if (!resource.path || resource.path === ":memory:" || resource.path.startsWith("file::memory:")) {
        throw Object.assign(new Error("real-db admission requires an on-disk SQLite database"), { code: "ADMISSION_FAILED", details: { path: resource.path ?? null } });
      }
      if (!existsSync(resource.path)) throw Object.assign(new Error("real-db admission could not verify the on-disk database"), { code: "ADMISSION_FAILED", details: { path: resource.path } });
      // `instanceof` is only the first gate.  Exercise the actual SQLite
      // handle and read the row back through the production adapter before a
      // real-db capability is admitted.  Shape-compatible impostors must not
      // be able to manufacture this proof.
      try {
        const sqlite = (resource.db as unknown as { $client?: { query: (sql: string) => { get: () => unknown } }; query?: (sql: string) => { get: () => unknown } }).$client ?? resource.db as unknown as { query: (sql: string) => { get: () => unknown } };
        sqlite.query("SELECT 1").get();
      } catch (cause) { throw Object.assign(new Error("real-db admission could not execute SQLite"), { code: "ADMISSION_FAILED", cause }); }
      const id = `testing-admission-${crypto.randomUUID()}`;
      await runDb(resource.insertRun({ runId: id, workflowName: "testing-framework", status: "running", createdAtMs: Date.now(), startedAtMs: Date.now(), heartbeatAtMs: null, runtimeOwnerId: "testing-framework" }));
      await runDb(resource.heartbeatRun(id, "testing-framework", Date.now()));
      const rows = await runDb(resource.listRuns(100, undefined, "testing-framework")) as readonly { readonly runId?: string }[];
      if (!rows.some((row) => row.runId === id)) throw Object.assign(new Error("real-db admission write was not durably readable"), { code: "ADMISSION_FAILED" });
    },
    cleanup: async () => {
      const native = (resource?.db as unknown as { $client?: { query: (sql: string) => { get: () => unknown } } } | undefined)?.$client;
      if (resource?.close) await resource.close();
      if (native) {
        try { native.query("SELECT 1").get(); throw Object.assign(new Error("CLEANUP_LEAK: database handle remained open after adapter cleanup"), { code: "CLEANUP_LEAK" }); }
        catch (error) { if ((error as { code?: string }).code === "CLEANUP_LEAK") throw error; }
      }
      resource = undefined;
    },
    runStep: async (operation, ...args) => {
      if (!resource) throw new Error("REAL_DB_NOT_ADMITTED");
      // Production cut-point names are resolved through the typed binding, not
      // through resource.operations. This keeps a real-db claim tied to the
      // actual SmithersDb implementation even when a scenario uses the
      // framework vocabulary rather than a method name.
      const requestedOperation = String(operation);
      const productionOperation = requestedOperation.replace(/#\d+$/, "");
      if (productionOperations.has(productionOperation)) {
        const bound = realDbCutPoints(resource)[productionOperation as keyof ReturnType<typeof realDbCutPoints>];
        if (typeof bound === "function") {
          const input = args.length === 1 ? args[0] : undefined;
          if (input && typeof input === "object" && !Array.isArray(input)) return (bound as (value: unknown) => unknown)(input);
          return (bound as (...values: readonly unknown[]) => unknown)(...args);
        }
      }
      const direct = (resource as unknown as Record<string, unknown>)[String(operation)];
      if (typeof direct === "function") return runDb((direct as (...values: readonly unknown[]) => unknown).apply(resource, [...args]));
      if (productionOperations.has(productionOperation)) throw Object.assign(new Error(`REAL_DB_OPERATION_UNAVAILABLE:${productionOperation} requires the admitted SmithersDb production method`), { code: "ADMISSION_FAILED" });
      const fn = resource.operations?.[String(operation)];
      if (!fn) throw new Error(`REAL_DB_OPERATION_UNAVAILABLE:${String(operation)}`);
      return (fn as (...values: readonly unknown[]) => unknown).apply(resource, [...args]);
    },
    injectFault: async (fault, context?: AdapterFaultContext) => {
      if (!resource) throw new Error("REAL_DB_NOT_ADMITTED");
      const pair = `${fault.operation}:${fault.phase}`;
      if (!executableCutPoints.has(pair)) throw Object.assign(new Error(`REAL_DB_FAULT_UNAVAILABLE:${pair}`), { code: "ADMISSION_FAILED" });
      // The fault fires AT the production transition; the adapter's part is a
      // native durable-state observation read back through the admitted
      // SmithersDb, so receipts prove what the real database recorded on each
      // side of the cut point rather than echoing the fault declaration.
      const input = (context?.input ?? undefined) as Readonly<{ runId?: string; nodeId?: string; iteration?: number; attempt?: number }> | undefined;
      const production = resource as unknown as Record<string, (...values: readonly unknown[]) => unknown>;
      const readRun = async (runId: string) => await runDb(production.getRun(runId)) as Readonly<{ status?: string; runtimeOwnerId?: string | null; heartbeatAtMs?: number | null; cancelRequestedAtMs?: number | null }> | undefined;
      const runProjection = (run: Awaited<ReturnType<typeof readRun>>) => ({ status: run?.status ?? null, runtimeOwnerId: run?.runtimeOwnerId ?? null, heartbeatAtMs: run?.heartbeatAtMs ?? null, cancelRequestedAtMs: run?.cancelRequestedAtMs ?? null });
      const observed: Record<string, unknown> = {};
      if (input?.runId && input.nodeId !== undefined && typeof production.getAttempt === "function") {
        const attempt = await runDb(production.getAttempt(input.runId, input.nodeId, input.iteration ?? 0, input.attempt ?? 1)) as Readonly<{ state?: string; finishedAtMs?: number | null; runtimeOwnerId?: string | null }> | undefined;
        if (attempt) observed.attempt = { state: attempt.state, finishedAtMs: attempt.finishedAtMs ?? null, runtimeOwnerId: attempt.runtimeOwnerId ?? null };
      }
      // During-task ambiguities are EXECUTED production transitions, never
      // declaration echoes: lease loss is a real claimRunForResume takeover
      // whose fencing then rejects the old owner's production heartbeat, and a
      // cancellation race is the production completion CAS genuinely losing to
      // the committed cancel request. Each outcome is read back from durable
      // state so the middleware can refuse to claim an ambiguity the database
      // never recorded.
      if (fault.phase === "during-task" && context?.invoked === true && input?.runId && typeof production.getRun === "function") {
        if (fault.operation === "heartbeat" && typeof resource.claimRunForResume === "function" && typeof resource.heartbeatRun === "function") {
          const before = await readRun(input.runId);
          const fencingOwner = "testing-fencing-owner";
          // A lease nobody holds cannot be lost: without a current owner the
          // takeover is not attempted and the receipt reports it un-executed.
          const previousOwner = typeof before?.runtimeOwnerId === "string" ? before.runtimeOwnerId : null;
          const claimHeartbeatAtMs = (before?.heartbeatAtMs ?? 0) + 1;
          const takeoverClaimed = previousOwner !== null && await runDb(resource.claimRunForResume({
            runId: input.runId, expectedStatus: before?.status ?? "running", expectedRuntimeOwnerId: previousOwner,
            expectedHeartbeatAtMs: before?.heartbeatAtMs ?? null, staleBeforeMs: claimHeartbeatAtMs,
            claimOwnerId: fencingOwner, claimHeartbeatAtMs, requireStale: false,
          })) === true;
          const rejectedHeartbeatAtMs = claimHeartbeatAtMs + 1;
          if (takeoverClaimed && previousOwner !== null) await runDb(resource.heartbeatRun(input.runId, previousOwner, rejectedHeartbeatAtMs));
          const after = await readRun(input.runId);
          observed.leaseTakeover = {
            executed: takeoverClaimed,
            previousOwner,
            fencingOwner,
            oldOwnerHeartbeatRejected: takeoverClaimed && after?.runtimeOwnerId === fencingOwner && after?.heartbeatAtMs === claimHeartbeatAtMs,
            before: runProjection(before),
            after: runProjection(after),
          };
        }
        if (fault.operation === "cancellation" && typeof resource.completeRun === "function") {
          const before = await readRun(input.runId);
          const completionOwner = before?.runtimeOwnerId ?? "owner";
          const completionAdmitted = await runDb(resource.completeRun(input.runId, completionOwner, (before?.cancelRequestedAtMs ?? 0) + 1)) === true;
          const after = await readRun(input.runId);
          observed.cancellationRace = {
            executed: true,
            cancelRequested: (before?.cancelRequestedAtMs ?? null) !== null,
            completionRejected: !completionAdmitted && after?.status !== "finished",
            winner: completionAdmitted ? "completion" : "cancellation",
            before: runProjection(before),
            after: runProjection(after),
          };
        }
      }
      if (input?.runId && typeof production.getRun === "function") {
        const run = await readRun(input.runId);
        if (run) observed.run = { status: run.status, runtimeOwnerId: run.runtimeOwnerId ?? null, heartbeatAtMs: run.heartbeatAtMs ?? null, cancelRequestedAtMs: run.cancelRequestedAtMs ?? null };
      }
      return { operation: fault.operation, phase: fault.phase, executed: true, invoked: context?.invoked === true, productionIdentity: "@smithers-orchestrator/db/adapter:SmithersDb", result: context?.result, observed };
    },
    serializeError: options.serializeError,
    extensionExecutors: options.extensionExecutors,
  }, "integration-real-db");
};

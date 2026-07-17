import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { registerTrustedAdapter, type HarnessAdapter } from "../harness/Harness.ts";
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
  return registerTrustedAdapter({
    identity: options.identity ?? "real-db:sqlite",
    verifiedProductionIdentity: "@smithers-orchestrator/db/adapter:SmithersDb",
    supportedCutPoints: new Set([
      "completion-cas:after-task", "completion-cas:after-journal-before-ack", "resume:before-task",
      "heartbeat:during-task", "lease:during-task", "cancellation:during-task",
    ]),
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
    injectFault: async (fault) => {
      if (!resource) throw new Error("REAL_DB_NOT_ADMITTED");
      const operation = resource.operations?.[`${fault.operation}:${fault.phase}`];
      if (!operation) throw Object.assign(new Error(`REAL_DB_FAULT_UNAVAILABLE:${fault.operation}:${fault.phase}`), { code: "ADMISSION_FAILED" });
      await (operation as (...values: readonly unknown[]) => unknown)(fault);
    },
    serializeError: options.serializeError,
    extensionExecutors: options.extensionExecutors,
  }, "integration-real-db");
};

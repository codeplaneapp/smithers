import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Effect } from "effect";
import { registerTrustedAdapter, type HarnessAdapter } from "../harness/Harness.ts";
import { realDbCutPoints } from "./realDbCutPoints.ts";

export type RealDbResource = SmithersDb & Readonly<{ readonly path?: string; readonly productionIdentity?: "SmithersDb"; readonly close: () => void | Promise<void>; readonly operations?: Readonly<Record<string, (...args: readonly unknown[]) => unknown | Promise<unknown>>> }>;
export type RealDbAdapterOptions = Readonly<{ readonly open: () => RealDbResource | Promise<RealDbResource>; readonly identity?: string; readonly serializeError?: HarnessAdapter["serializeError"]; readonly extensionExecutors?: HarnessAdapter["extensionExecutors"] }>;

export const realDbAdapter = (options: RealDbAdapterOptions): HarnessAdapter => {
  const productionOperations = new Set(["claimAttemptCompletion", "claimRunForResume", "heartbeatRun", "completeRun", "requestRunCancel", "claimRunCancellation", "heartbeatAttempt"]);
  let resource: RealDbResource | undefined;
  const runDb = async <T>(value: T | Promise<T>): Promise<T> => {
    if (value && typeof (value as unknown as { then?: unknown }).then === "function") return await value;
    if (value && typeof (value as unknown as { pipe?: unknown }).pipe === "function") return Effect.runPromise(value as never) as Promise<T>;
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
      const rows = await runDb(resource.listRuns(100, undefined, "testing-framework"));
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
      const direct = (resource as unknown as Record<string, unknown>)[String(operation)];
      if (typeof direct === "function") return runDb((direct as (...values: readonly unknown[]) => unknown).apply(resource, args));
      // Production cut-point names are resolved through the typed binding, not
      // through resource.operations. This keeps a real-db claim tied to the
      // actual SmithersDb implementation even when a scenario uses the
      // framework vocabulary rather than a method name.
      if (productionOperations.has(String(operation))) {
        const bound = realDbCutPoints(resource)[String(operation) as keyof ReturnType<typeof realDbCutPoints>];
        if (typeof bound === "function") return bound(...args as never[]);
      }
      if (productionOperations.has(String(operation))) throw Object.assign(new Error(`REAL_DB_OPERATION_UNAVAILABLE:${String(operation)} requires the admitted SmithersDb production method`), { code: "ADMISSION_FAILED" });
      const fn = resource.operations?.[String(operation)];
      if (!fn) throw new Error(`REAL_DB_OPERATION_UNAVAILABLE:${String(operation)}`);
      return fn.apply(resource, args);
    },
    injectFault: async (fault) => {
      if (!resource) throw new Error("REAL_DB_NOT_ADMITTED");
      const operation = resource.operations?.[`${fault.operation}:${fault.phase}`];
      if (!operation) throw Object.assign(new Error(`REAL_DB_FAULT_UNAVAILABLE:${fault.operation}:${fault.phase}`), { code: "ADMISSION_FAILED" });
      await operation(fault);
    },
    serializeError: options.serializeError,
    extensionExecutors: options.extensionExecutors,
  }, "integration-real-db");
};

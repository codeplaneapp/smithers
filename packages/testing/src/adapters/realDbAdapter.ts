import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import type { HarnessAdapter } from "../harness/Harness.ts";

export type RealDbResource = SmithersDb & Readonly<{ readonly path?: string; readonly productionIdentity?: "SmithersDb"; readonly close: () => void | Promise<void>; readonly operations?: Readonly<Record<string, (...args: readonly unknown[]) => unknown | Promise<unknown>>> }>;
export type RealDbAdapterOptions = Readonly<{ readonly open: () => RealDbResource | Promise<RealDbResource>; readonly identity?: string }>;

export const realDbAdapter = (options: RealDbAdapterOptions): HarnessAdapter => {
  let resource: RealDbResource | undefined;
  return {
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
      const id = `testing-admission-${crypto.randomUUID()}`;
      await resource.insertRun({ runId: id, workflowName: "testing-framework", status: "running", createdAtMs: Date.now(), startedAtMs: Date.now(), heartbeatAtMs: null, runtimeOwnerId: "testing-framework" });
      await resource.heartbeatRun(id, "testing-framework", Date.now());
    },
    cleanup: async () => { if (resource?.close) await resource.close(); resource = undefined; },
    runStep: async (operation, ...args) => {
      if (!resource) throw new Error("REAL_DB_NOT_ADMITTED");
      const direct = (resource as unknown as Record<string, unknown>)[String(operation)];
      if (typeof direct === "function") return (direct as (...values: readonly unknown[]) => unknown).apply(resource, args);
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
  };
};

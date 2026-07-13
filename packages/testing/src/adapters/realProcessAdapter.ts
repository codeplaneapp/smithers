import type { ChildProcess } from "node:child_process";
import { registerTrustedAdapter, type HarnessAdapter } from "../harness/Harness.ts";
import type { ScenarioFault } from "../scenario/ast.ts";

/** A resource created by the repository's engineChildRunner protocol. */
export type RealProcessResource = Readonly<{
  readonly pid: number;
  readonly child: ChildProcess;
  readonly handshake: () => boolean | Promise<boolean>;
  readonly kill: (signal?: string) => void | Promise<void>;
  readonly close: () => void | Promise<void>;
  /** Production-owned fresh-process continuation used by the restart cut point. */
  readonly resume?: () => RealProcessResource | Promise<RealProcessResource>;
  readonly healthy?: () => boolean | Promise<boolean>;
}>;
export type RealProcessAdapterOptions = Readonly<{ readonly spawn: () => RealProcessResource | Promise<RealProcessResource>; readonly identity?: string }>;

const exited = (child: ChildProcess, budgetMs = 1_000): Promise<void> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => { if (timer) clearTimeout(timer); resolve(); };
  child.once("exit", done);
  timer = setTimeout(done, budgetMs);
});

export const realProcessAdapter = (options: RealProcessAdapterOptions): HarnessAdapter => {
  let resource: RealProcessResource | undefined;
  return registerTrustedAdapter({
    identity: options.identity ?? "real-process:child",
    verifiedProductionIdentity: "smithers-engine:runWorkflow-child",
    supportedCutPoints: new Set(["resume:during-task"]),
    admissionProbe: async () => {
      resource = await options.spawn();
      // Identity is derived from the actual child command and an authenticated
      // production handshake. Caller-supplied protocol/identity strings and
      // verification callbacks are deliberately not accepted as evidence.
      const args = resource.child?.spawnargs ?? [];
      const productionRunner = args.some((arg) => /(?:^|\/)engineChildRunner\.tsx?$/.test(arg));
      if (!resource.child || resource.child.pid !== resource.pid || resource.pid === process.pid || !Number.isInteger(resource.pid) || resource.pid <= 0 || !productionRunner || !(await resource.handshake()) || (resource.healthy && !(await resource.healthy()))) throw Object.assign(new Error("real process failed admission: the child did not prove the production runWorkflow protocol"), { code: "ADMISSION_FAILED" });
      try { process.kill(resource.pid, 0); } catch (cause) { throw Object.assign(new Error("real process is not a live production child"), { code: "ADMISSION_FAILED", cause }); }
    },
    cleanup: async () => {
      if (!resource) return;
      await resource.kill("SIGKILL");
      await exited(resource.child);
      await resource.close();
      if (resource.child.exitCode === null && resource.child.signalCode === null) throw Object.assign(new Error(`CLEANUP_LEAK: child/${resource.pid}`), { code: "CLEANUP_LEAK" });
      resource = undefined;
    },
    runStep: async (operation, ...args) => {
      if (!resource) throw new Error("REAL_PROCESS_NOT_ADMITTED");
      if (operation === "kill") return resource.kill(String(args[0] ?? "SIGKILL"));
      if (operation !== "runWorkflow") throw Object.assign(new Error(`REAL_PROCESS_OPERATION_UNAVAILABLE:${String(operation)}`), { code: "ADMISSION_FAILED" });
      return resource.pid;
    },
    injectFault: async (fault: ScenarioFault) => {
      if (!resource) throw new Error("REAL_PROCESS_NOT_ADMITTED");
      if (fault.operation !== "resume" || fault.phase !== "during-task") throw Object.assign(new Error(`REAL_PROCESS_FAULT_UNAVAILABLE:${fault.operation}:${fault.phase}`), { code: "ADMISSION_FAILED" });
      await resource.kill("SIGKILL");
      await exited(resource.child);
      if (!resource.resume) throw Object.assign(new Error("REAL_PROCESS_RESUME_UNAVAILABLE"), { code: "ADMISSION_FAILED" });
      resource = await resource.resume();
    },
  }, "e2e-real-process");
};

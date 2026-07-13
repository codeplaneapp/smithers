import type { ChildProcess } from "node:child_process";
import { registerTrustedAdapter, type HarnessAdapter } from "../harness/Harness.ts";
import type { ScenarioFault } from "../scenario/ast.ts";

/** A resource created by the repository's engineChildRunner protocol. */
export type RealProcessResource = Readonly<{
  readonly pid: number;
  readonly child: ChildProcess;
  /** The child must echo the adapter-owned nonce; a truthy caller boolean is
   * deliberately not accepted as process identity evidence. */
  readonly handshake: (nonce: string) => string | Promise<string>;
  readonly kill: (signal?: string) => void | Promise<void>;
  readonly close: () => void | Promise<void>;
  /** Production-owned fresh-process continuation used by the restart cut point. */
  readonly resume?: (nonce: string) => RealProcessResource | Promise<RealProcessResource>;
  readonly healthy?: () => boolean | Promise<boolean>;
}>;
export type RealProcessAdapterOptions = Readonly<{ readonly spawn: (nonce: string) => RealProcessResource | Promise<RealProcessResource>; readonly identity?: string }>;

const exited = (child: ChildProcess, budgetMs = 1_000): Promise<void> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => { if (timer) clearTimeout(timer); resolve(); };
  child.once("exit", done);
  timer = setTimeout(done, budgetMs);
});

export const realProcessAdapter = (options: RealProcessAdapterOptions): HarnessAdapter => {
  let resource: RealProcessResource | undefined;
  const tracked = new Set<RealProcessResource>();
  const nonces = new Set<string>();
  const challenge = () => { const nonce = crypto.randomUUID(); nonces.add(nonce); return nonce; };
  return registerTrustedAdapter({
    identity: options.identity ?? "real-process:child",
    verifiedProductionIdentity: "smithers-engine:runWorkflow-child",
    supportedCutPoints: new Set(["resume:during-task"]),
    admissionProbe: async () => {
      const nonce = challenge();
      resource = await options.spawn(nonce);
      tracked.add(resource);
      // Identity is derived from the actual child command and an authenticated
      // production handshake. Caller-supplied protocol/identity strings and
      // verification callbacks are deliberately not accepted as evidence.
      const args = resource.child?.spawnargs ?? [];
      const productionRunner = args.some((arg) => /(?:^|\/)engineChildRunner\.tsx?$/.test(arg));
      const response = await resource.handshake(nonce);
      if (!resource.child || resource.child.pid !== resource.pid || resource.pid === process.pid || !Number.isInteger(resource.pid) || resource.pid <= 0 || !productionRunner || response !== nonce || (resource.healthy && !(await resource.healthy()))) throw Object.assign(new Error("real process failed admission: the child did not prove the production runWorkflow protocol"), { code: "ADMISSION_FAILED" });
      try { process.kill(resource.pid, 0); } catch (cause) { throw Object.assign(new Error("real process is not a live production child"), { code: "ADMISSION_FAILED", cause }); }
    },
    cleanup: async () => {
      for (const childResource of tracked) {
        if (childResource.child.exitCode === null && childResource.child.signalCode === null) await childResource.kill("SIGKILL");
        await exited(childResource.child);
        await childResource.close();
        if (childResource.child.exitCode === null && childResource.child.signalCode === null) throw Object.assign(new Error(`CLEANUP_LEAK: child/${childResource.pid}`), { code: "CLEANUP_LEAK" });
      }
      tracked.clear();
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
      if (resource.child.signalCode !== "SIGKILL") throw Object.assign(new Error("real process replacement requires observed SIGKILL terminal event"), { code: "ADMISSION_FAILED", details: { pid: resource.pid, signalCode: resource.child.signalCode } });
      if (!resource.resume) throw Object.assign(new Error("REAL_PROCESS_RESUME_UNAVAILABLE"), { code: "ADMISSION_FAILED" });
      const nonce = challenge();
      const resumed = await resource.resume(nonce);
      if (resumed.pid === resource.pid) throw Object.assign(new Error("real process resume must create a distinct child"), { code: "ADMISSION_FAILED" });
      if (await resumed.handshake(nonce) !== nonce) throw Object.assign(new Error("resumed process failed nonce challenge"), { code: "ADMISSION_FAILED" });
      tracked.add(resumed);
      resource = resumed;
    },
  }, "e2e-real-process");
};

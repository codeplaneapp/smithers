import type { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
  /** Production-owned result observed from stdout/durable completion. */
  readonly resultStatus?: () => string | undefined | Promise<string | undefined>;
  /** Reads durable/effect evidence owned by the production fixture. */
  readonly observeDurableState?: () => RealProcessDurableState | Promise<RealProcessDurableState>;
}>;
export type RealProcessDurableState = Readonly<{ readonly effectApplied: boolean; readonly journalWritten: boolean; readonly outputPersisted: boolean }>;
export type RealProcessObservation = Readonly<{
  readonly terminatedBy: "SIGKILL";
  readonly preKillEffectApplied: boolean;
  readonly journalWritten: boolean;
  readonly outputPersisted: boolean;
  readonly resumed: boolean;
  readonly resumedStatus?: string;
  readonly resumedEffectApplied?: boolean;
  readonly resumedJournalWritten?: boolean;
  readonly resumedOutputPersisted?: boolean;
}>;
export type RealProcessAdapterOptions = Readonly<{
  /** Launch input for the ACTUAL production runWorkflow child. Invoked only by
   * runStep("runWorkflow") — never during admission — so a scenario that
   * schedules no runWorkflow step provably executes no target workflow. */
  readonly spawn: (nonce: string) => RealProcessResource | Promise<RealProcessResource>;
  /** Launch input for the admission identity/liveness probe: a child of the
   * same repository-owned runner that completes the `probe:<nonce>` handshake
   * and exits 0 WITHOUT executing the target workflow. */
  readonly probe: (nonce: string) => RealProcessResource | Promise<RealProcessResource>;
  /** Absolute path to the repository-owned engineChildRunner. Required proof of identity. */
  readonly runnerPath: string;
  readonly identity?: string;
  readonly serializeError?: HarnessAdapter["serializeError"];
  readonly extensionExecutors?: HarnessAdapter["extensionExecutors"];
}>;

/**
 * Resolve the repository-owned engineChildRunner anchored at THIS module and
 * probed upward, so the identical identity resolution holds from the
 * TypeScript source (src/adapters/) and from the shipped bundle (src/index.js)
 * whose `import.meta.url` sits one directory higher: the first ancestor owning
 * e2e/harness/engineChildRunner.ts is the repository root in both layouts.
 */
const repositoryRunner = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    try { return realpathSync(resolve(dir, "e2e/harness/engineChildRunner.ts")); } catch { dir = resolve(dir, ".."); }
  }
  throw Object.assign(new Error("real process admission requires the repository-owned engineChildRunner"), { code: "ADMISSION_FAILED" });
};

const exited = (child: ChildProcess, budgetMs = 1_000): Promise<void> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => { if (timer) clearTimeout(timer); resolve(); };
  child.once("exit", done);
  timer = setTimeout(done, budgetMs);
});

const verifiedChild = (resource: RealProcessResource, expectedRunner: string, nonce: string): boolean => {
  const args = resource.child.spawnargs ?? [];
  if (resource.child.pid !== resource.pid || resource.pid <= 0 || resource.pid === process.pid) return false;
  if (String(args[0] ?? "").split("/").pop() !== "bun") return false;
  if (!args[1]) return false;
  try { if (realpathSync(String(args[1])) !== expectedRunner) return false; } catch { return false; }
  return args.some((arg) => String(arg) === nonce);
};

/** Adapter-owned verification of one spawned child against the production
 * runner identity and its phase-specific nonce marker. Identity is derived
 * from the actual child command and an authenticated production handshake;
 * caller-supplied protocol/identity strings and verification callbacks are
 * deliberately not accepted as evidence. */
const verifyProtocol = async (resource: RealProcessResource, expectedRunner: string, nonce: string, marker: string): Promise<{ readonly verified: boolean; readonly read: () => string }> => {
  const args = resource.child?.spawnargs ?? [];
  const executable = args[0] ? String(args[0]).split("/").pop() : "";
  // The production runner is the executable script entrypoint, not an argv
  // suffix. This rejects `bun -e ... <engineChildRunner.ts>` echoers even
  // when they print the public marker and return a truthy callback result.
  const productionRunner = args[1] !== undefined && (() => { try { return realpathSync(String(args[1])) === expectedRunner; } catch { return false; } })();
  let stdout = "";
  resource.child?.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  // The adapter, not the caller's handshake callback, authenticates the
  // production marker. A shell can echo the nonce but cannot satisfy the
  // exact executable + exact runner-path identity checks.
  const deadline = Date.now() + 250;
  while (!stdout.includes(`${marker}:${nonce}`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const nonceInArgv = args.some((arg) => String(arg) === nonce);
  const identityVerified = Boolean(resource.child) && verifiedChild(resource, expectedRunner, nonce) && Number.isInteger(resource.pid) && executable === "bun" && productionRunner && nonceInArgv;
  // Some callers attach their stdout consumer before handing the resource
  // to the adapter. In that case the marker is already consumed; the
  // callback is accepted only as a liveness hint after the independent,
  // exact command identity checks above have passed.
  const markerVerified = stdout.includes(`${marker}:${nonce}`) || (identityVerified && await resource.handshake(nonce) === nonce);
  return { verified: identityVerified && markerVerified, read: () => stdout };
};

export const realProcessAdapter = (options: RealProcessAdapterOptions): HarnessAdapter => {
  let admitted = false;
  let resource: RealProcessResource | undefined;
  const tracked = new Set<RealProcessResource>();
  const nonces = new Set<string>();
  const challenge = () => { const nonce = crypto.randomUUID(); nonces.add(nonce); return nonce; };
  return registerTrustedAdapter({
    identity: options.identity ?? "real-process:child",
    verifiedProductionIdentity: "smithers-engine:runWorkflow-child",
    supportedCutPoints: new Set(["resume:during-task"]),
    admissionProbe: async () => {
      let suppliedRunner: string;
      let expectedRunner: string;
      try { suppliedRunner = realpathSync(options.runnerPath); expectedRunner = repositoryRunner(); } catch (cause) { throw Object.assign(new Error("real process admission requires the repository-owned engineChildRunner"), { code: "ADMISSION_FAILED", cause }); }
      if (suppliedRunner !== expectedRunner) throw Object.assign(new Error("real process admission rejected: runner identity is not repository-owned"), { code: "ADMISSION_FAILED", details: { suppliedRunner, expectedRunner } });
      // Admission proves runner identity and production liveness with a PROBE
      // child that must never execute the target workflow. The runWorkflow
      // transition itself belongs exclusively to runStep("runWorkflow"), so a
      // scenario that never schedules that operation runs no target workflow.
      const nonce = challenge();
      const probeChild = await options.probe(nonce);
      tracked.add(probeChild);
      const protocol = await verifyProtocol(probeChild, expectedRunner, nonce, "SMITHERS_ENGINE_HANDSHAKE=probe");
      nonces.delete(nonce);
      if (!protocol.verified || (probeChild.healthy && !(await probeChild.healthy()))) throw Object.assign(new Error("real process failed admission: the probe child did not prove the repository production probe protocol"), { code: "ADMISSION_FAILED" });
      await exited(probeChild.child, 30_000);
      if (probeChild.child.exitCode !== 0) throw Object.assign(new Error("real process admission probe did not exit cleanly"), { code: "ADMISSION_FAILED", details: { pid: probeChild.pid, exitCode: probeChild.child.exitCode, signalCode: probeChild.child.signalCode } });
      // A probe that claimed the workflow protocol or left durable workflow
      // evidence executed the target — admission must fail, not absorb it.
      if (protocol.read().includes("SMITHERS_ENGINE_HANDSHAKE=runWorkflow:")) throw Object.assign(new Error("real process admission probe illegally claimed the runWorkflow protocol"), { code: "ADMISSION_FAILED" });
      const durable = await probeChild.observeDurableState?.();
      if (durable && (durable.effectApplied || durable.outputPersisted)) throw Object.assign(new Error("real process admission probe must not execute the target workflow"), { code: "ADMISSION_FAILED", details: durable });
      admitted = true;
    },
    cleanup: async () => {
      for (const childResource of tracked) {
        if (childResource.child.exitCode === null && childResource.child.signalCode === null) await childResource.kill("SIGKILL");
        await exited(childResource.child);
        await childResource.close();
        if (childResource.child.exitCode === null && childResource.child.signalCode === null) await childResource.kill("SIGKILL");
        if (childResource.child.exitCode === null && childResource.child.signalCode === null) throw Object.assign(new Error(`CLEANUP_LEAK: child/${childResource.pid}`), { code: "CLEANUP_LEAK" });
      }
      tracked.clear();
      resource = undefined;
      admitted = false;
    },
    runStep: async (operation, ...args) => {
      if (!admitted) throw new Error("REAL_PROCESS_NOT_ADMITTED");
      if (operation === "kill") {
        if (!resource) throw new Error("REAL_PROCESS_RUNWORKFLOW_NOT_STARTED");
        return resource.kill(String(args[0] ?? "SIGKILL"));
      }
      if (operation !== "runWorkflow") throw Object.assign(new Error(`REAL_PROCESS_OPERATION_UNAVAILABLE:${String(operation)}`), { code: "ADMISSION_FAILED" });
      // THIS is the production transition the middleware wraps: start the
      // actual runWorkflow child under a fresh adapter-owned nonce and hold it
      // verified and observably in flight, so a during-task fault is injected
      // while the production operation is genuinely executing.
      let expectedRunner: string;
      try { expectedRunner = repositoryRunner(); } catch (cause) { throw Object.assign(new Error("real process runWorkflow requires the repository-owned engineChildRunner"), { code: "ADMISSION_FAILED", cause }); }
      const nonce = challenge();
      const spawned = await options.spawn(nonce);
      tracked.add(spawned);
      const protocol = await verifyProtocol(spawned, expectedRunner, nonce, "SMITHERS_ENGINE_HANDSHAKE=runWorkflow");
      nonces.delete(nonce);
      if (!protocol.verified) throw Object.assign(new Error("real process runWorkflow child failed executable identity and nonce challenge"), { code: "ADMISSION_FAILED" });
      try { process.kill(spawned.pid, 0); } catch (cause) { throw Object.assign(new Error("real process runWorkflow child is not a live production child"), { code: "ADMISSION_FAILED", cause }); }
      if (!spawned.observeDurableState) throw Object.assign(new Error("REAL_PROCESS_OBSERVATION_UNAVAILABLE"), { code: "ADMISSION_FAILED" });
      // The transition is returned only once it is observably IN FLIGHT from
      // durable state (the workflow's first mid-task evidence exists) while
      // the child is still alive — a finished or dead child cannot host a
      // during-task fault.
      const deadline = Date.now() + 30_000;
      let inFlight = (await spawned.observeDurableState()).effectApplied;
      while (!inFlight && Date.now() < deadline && spawned.child.exitCode === null && spawned.child.signalCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        inFlight = (await spawned.observeDurableState()).effectApplied;
      }
      if (!inFlight || spawned.child.exitCode !== null || spawned.child.signalCode !== null) throw Object.assign(new Error("real process runWorkflow is not observably in flight"), { code: "ADMISSION_FAILED", details: { pid: spawned.pid, inFlight, exitCode: spawned.child.exitCode, signalCode: spawned.child.signalCode } });
      resource = spawned;
      return spawned.pid;
    },
    injectFault: async (fault: ScenarioFault): Promise<RealProcessObservation> => {
      if (!admitted) throw new Error("REAL_PROCESS_NOT_ADMITTED");
      if (!resource) throw new Error("REAL_PROCESS_RUNWORKFLOW_NOT_STARTED");
      if (fault.operation !== "resume" || fault.phase !== "during-task") throw Object.assign(new Error(`REAL_PROCESS_FAULT_UNAVAILABLE:${fault.operation}:${fault.phase}`), { code: "ADMISSION_FAILED" });
      // Capture the durable/effect observation before termination. Reading it
      // after replacement can accidentally report the resumed child's state
      // as evidence for the killed attempt.
      const preKill = await resource.observeDurableState?.();
      if (!preKill) throw Object.assign(new Error("REAL_PROCESS_OBSERVATION_UNAVAILABLE"), { code: "ADMISSION_FAILED" });
      await resource.kill("SIGKILL");
      await exited(resource.child);
      if (resource.child.signalCode !== "SIGKILL") throw Object.assign(new Error("real process replacement requires observed SIGKILL terminal event"), { code: "ADMISSION_FAILED", details: { pid: resource.pid, signalCode: resource.child.signalCode } });
      if (!resource.resume || !resource.observeDurableState) throw Object.assign(new Error("REAL_PROCESS_OBSERVATION_UNAVAILABLE"), { code: "ADMISSION_FAILED" });
      const nonce = challenge();
      const resumed = await resource.resume(nonce);
      if (resumed.pid === resource.pid) throw Object.assign(new Error("real process resume must create a distinct child"), { code: "ADMISSION_FAILED" });
      let resumedRunner: string;
      try { resumedRunner = repositoryRunner(); } catch (cause) { throw Object.assign(new Error("resumed process runner is unavailable"), { code: "ADMISSION_FAILED", cause }); }
      if (!verifiedChild(resumed, resumedRunner, nonce) || await resumed.handshake(nonce) !== nonce) throw Object.assign(new Error("resumed process failed executable identity and nonce challenge"), { code: "ADMISSION_FAILED" });
      const exitCode = resumed.child.exitCode;
      if (!resumed.resultStatus) throw Object.assign(new Error("real process resume must expose an adapter-owned production result observer"), { code: "ADMISSION_FAILED" });
      const status = await resumed.resultStatus();
      if (!resumed.observeDurableState) throw Object.assign(new Error("REAL_PROCESS_RESUME_OBSERVATION_UNAVAILABLE"), { code: "ADMISSION_FAILED" });
      const resumedState = await resumed.observeDurableState();
      if (exitCode !== 0 || status !== "finished") throw Object.assign(new Error("real process resume did not produce a successful production result"), { code: "ADMISSION_FAILED", details: { pid: resumed.pid, exitCode, status } });
      if (!resumedState.outputPersisted) throw Object.assign(new Error("real process resume did not durably persist the expected output"), { code: "ADMISSION_FAILED", details: { pid: resumed.pid, outputPersisted: resumedState.outputPersisted } });
      tracked.add(resumed);
      resource = resumed;
      return { terminatedBy: "SIGKILL", preKillEffectApplied: preKill.effectApplied, journalWritten: preKill.journalWritten, outputPersisted: preKill.outputPersisted, resumed: true, resumedStatus: status, resumedEffectApplied: resumedState.effectApplied, resumedJournalWritten: resumedState.journalWritten, resumedOutputPersisted: resumedState.outputPersisted };
    },
    serializeError: options.serializeError,
    extensionExecutors: options.extensionExecutors,
  }, "e2e-real-process");
};

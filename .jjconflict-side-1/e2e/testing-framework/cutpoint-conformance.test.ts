import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import * as sourceEntry from "@smithers-orchestrator/testing";
import * as shippedEntry from "../../packages/testing/src/index.js";
import type { ScenarioResult } from "@smithers-orchestrator/testing";
import { makeEngineChildFixture } from "./testingProcessFixture.ts";

/**
 * Real-adapter invocation rows of the cut-point conformance table: every pair
 * an admitted real adapter advertises fires at the ACTUAL production
 * transition — the real-db rows against a live SmithersDb (before-phase
 * faults leave the durable row untouched, after/ack/during faults observe the
 * executed transition), and the real-process resume:during-task row against a
 * live engineChildRunner child (adapter-owned SIGKILL, observed terminal
 * signal, verified fresh-process resume) — with the adapter's injectFault
 * producing a native durable-state receipt through the ONE operation/phase
 * middleware. Occurrence, non-occurrence, and unsupported-harness admission
 * rows for every compiler-admitted pair live in
 * packages/testing/tests/cutpoint-conformance.test.ts.
 *
 * The table runs against BOTH runtime entrypoints: the tsconfig-alias
 * TypeScript source AND the committed src/index.js package artifact that
 * `@smithers-orchestrator/testing` actually publishes via its exports map —
 * a green source suite must never mask a stale shipped bundle.
 */
const ENTRYPOINTS = [
  { label: "source", M: sourceEntry },
  { label: "shipped", M: shippedEntry as unknown as typeof sourceEntry },
] as const;

test("the shipped entrypoint is the committed JavaScript artifact, not a rewrite of the TypeScript source", () => {
  // Bun resolves an explicit `.js` specifier to the actual file. If it had
  // been rewritten to index.ts, both imports would be the SAME module
  // instance; distinctness proves the published artifact genuinely loaded.
  expect(shippedEntry as unknown).not.toBe(sourceEntry as unknown);
  const resolved = Bun.resolveSync("../../packages/testing/src/index.js", import.meta.dir);
  expect(resolved.endsWith("/packages/testing/src/index.js")).toBe(true);
  expect(Bun.resolveSync("@smithers-orchestrator/testing", import.meta.dir).endsWith("/packages/testing/src/index.ts")).toBe(true);
});

const paths: string[] = [];
const clients: Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); for (const path of paths.splice(0)) { rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true }); } });

const now = 1_700_000_000_000;
const openSeededDb = async (label: string, M: typeof sourceEntry) => {
  const dbPath = join(tmpdir(), `smithers-testing-cutpoint-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(dbPath);
  const { db } = createSmithers({ input: z.object({}), result: z.object({ value: z.number() }) }, { dbPath });
  ensureSmithersTables(db);
  const client = (db as { $client?: Database }).$client;
  if (!client) throw new Error("createSmithers did not expose its real sqlite client");
  clients.push(client);
  const adapter = new SmithersDb(db);
  const runId = `cutpoint-${label}`;
  await adapter.insertRun({ runId, workflowName: "testing-framework", status: "running", createdAtMs: now - 100_000, startedAtMs: now - 100_000, heartbeatAtMs: now - 100_000, runtimeOwnerId: "owner" });
  await adapter.insertAttempt({ runId, nodeId: "node", iteration: 0, attempt: 1, state: "in-progress", startedAtMs: now - 100_000, runtimeOwnerId: "owner" });
  const resource = Object.assign(adapter, { path: dbPath, productionIdentity: "SmithersDb" as const, close: () => { client.close(); } });
  return { runId, dbPath, resource, harness: M.integrationHarness({ adapter: M.realDbAdapter({ open: async () => resource }) }) };
};
const reopen = async (dbPath: string) => new SmithersDb(new (await import("bun:sqlite")).Database(dbPath));
const lastReceipt = (result: ScenarioResult) => {
  const events = result.trace.filter((event) => event.type === "durability");
  return (events.at(-1)?.data as { receipt?: { stepId: string; faultId: string; productionOperation: string; invoked: boolean; adapter: string; observation?: { executed?: boolean; invoked?: boolean; observed?: { attempt?: { state?: string }; run?: { runtimeOwnerId?: string | null; heartbeatAtMs?: number | null; cancelRequestedAtMs?: number | null }; leaseTakeover?: { executed?: boolean; previousOwner?: string | null; fencingOwner?: string; oldOwnerHeartbeatRejected?: boolean }; cancellationRace?: { executed?: boolean; cancelRequested?: boolean; completionRejected?: boolean; winner?: string } } } } } | undefined)?.receipt;
};
const casInput = (runId: string, finishedAtMs: number) => ({ runId, nodeId: "node", iteration: 0, attempt: 1, runtimeOwnerId: "owner", finishedAtMs });

for (const { label, M } of ENTRYPOINTS) describe(`real-adapter cut-point invocation (${label} entrypoint)`, () => {
  const { runScenario, scenario, step, fault, integrationHarness, realDbAdapter } = M;

  test("completion-cas:before-task fires BEFORE the production CAS executes", async () => {
    const { runId, dbPath, harness } = await openSeededDb(`cas-before-${label}`, M);
    const result = await runScenario(scenario("cas-before", { steps: [step("claimAttemptCompletion", { input: casInput(runId, now + 1) })], faults: [fault("probe", "before-task", "completion-cas")] }), { harness });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const receipt = lastReceipt(result);
    expect(receipt?.productionOperation).toBe("claimAttemptCompletion");
    expect(receipt?.invoked).toBe(false);
    expect(receipt?.adapter).toBe("real-db:sqlite");
    expect(receipt?.observation?.executed).toBe(true);
    expect(receipt?.observation?.observed?.attempt?.state).toBe("in-progress");
    const verify = await reopen(dbPath);
    try { expect((await verify.getAttempt(runId, "node", 0, 1))?.state).toBe("in-progress"); } finally { verify.db.close(); }
  });

  test("completion-cas:after-task fires AT the executed production CAS transition", async () => {
    const { runId, dbPath, harness } = await openSeededDb(`cas-after-${label}`, M);
    const result = await runScenario(scenario("cas-after", { steps: [step("claimAttemptCompletion", { input: casInput(runId, now + 2) })], faults: [fault("probe", "after-task", "completion-cas")] }), { harness });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const receipt = lastReceipt(result);
    expect(receipt?.invoked).toBe(true);
    expect(receipt?.observation?.observed?.attempt?.state).toBe("finished");
    const verify = await reopen(dbPath);
    try { expect((await verify.getAttempt(runId, "node", 0, 1))?.state).toBe("finished"); } finally { verify.db.close(); }
  });

  test("completion-cas:after-journal-before-ack observes the journaled CAS and records the ack ambiguity", async () => {
    const { runId, dbPath, harness } = await openSeededDb(`cas-ack-${label}`, M);
    const result = await runScenario(scenario("cas-ack", { steps: [step("claimAttemptCompletion", { input: casInput(runId, now + 3) })], faults: [fault("probe", "after-journal-before-ack", "completion-cas")] }), { harness });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const ack = result.ambiguity.find((item) => item.outcome === "journal-applied-ack-missing");
    expect(ack).toBeDefined();
    expect((ack?.details as { observed?: boolean } | undefined)?.observed).toBe(true);
    // The ambiguity carries the durable read-back of the APPLIED transition,
    // not just the CAS return value.
    expect((ack?.details as { durable?: { attempt?: { state?: string } } } | undefined)?.durable?.attempt?.state).toBe("finished");
    const receipt = lastReceipt(result);
    expect(receipt?.invoked).toBe(true);
    expect(receipt?.observation?.observed?.attempt?.state).toBe("finished");
    const verify = await reopen(dbPath);
    try { expect((await verify.getAttempt(runId, "node", 0, 1))?.state).toBe("finished"); } finally { verify.db.close(); }
  });

  test("rejected/duplicate CAS: after-journal-before-ack is a NON-occurrence when the production CAS rejects", async () => {
    const { runId, dbPath, harness, resource } = await openSeededDb(`cas-rejected-${label}`, M);
    // The first completion is applied durably BEFORE the scenario runs, so the
    // scenario's CAS is a genuine duplicate the production predicate rejects.
    expect(await resource.claimAttemptCompletion(runId, "node", 0, 1, "owner", now + 1)).toBe(true);
    const result = await runScenario(scenario("cas-rejected", { steps: [step("claimAttemptCompletion", { input: casInput(runId, now + 2) })], faults: [fault("probe", "after-journal-before-ack", "completion-cas")] }), { harness });
    // A rejected CAS applied NO journal transition: the declared ack cut
    // point must not fire, must not invoke injectFault, and must never
    // manufacture journal-applied ambiguity from the declaration alone.
    expect(result.status).toBe("finished");
    expect(result.outputs.claimAttemptCompletion).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.ambiguity.some((item) => item.outcome === "journal-applied-ack-missing")).toBe(false);
    expect(result.trace.some((event) => event.type === "durability")).toBe(false);
    expect(result.trace.some((event) => event.type === "fault")).toBe(false);
    const rejected = result.ambiguity.find((item) => item.outcome === "duplicate-delivery");
    expect(rejected).toBeDefined();
    expect((rejected?.details as { transition?: string } | undefined)?.transition).toBe("completion-cas-rejected");
    const verify = await reopen(dbPath);
    try {
      const attempt = await verify.getAttempt(runId, "node", 0, 1);
      expect(attempt?.state).toBe("finished");
      // The first completion won; the duplicate did not overwrite it.
      expect(attempt?.finishedAtMs).toBe(now + 1);
    } finally { verify.db.close(); }
  });

  test("resume:before-task fires BEFORE the production resume claim executes", async () => {
    const { runId, dbPath, harness } = await openSeededDb(`resume-before-${label}`, M);
    const resumeInput = { runId, expectedStatus: "running", expectedRuntimeOwnerId: "owner", expectedHeartbeatAtMs: now - 100_000, staleBeforeMs: now - 1_000, claimOwnerId: "new-owner", claimHeartbeatAtMs: now, requireStale: true };
    const result = await runScenario(scenario("resume-before", { steps: [step("claimRunForResume", { input: resumeInput })], faults: [fault("probe", "before-task", "resume")] }), { harness });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const receipt = lastReceipt(result);
    expect(receipt?.productionOperation).toBe("claimRunForResume");
    expect(receipt?.invoked).toBe(false);
    const verify = await reopen(dbPath);
    try { expect((await verify.getRun(runId))?.runtimeOwnerId).toBe("owner"); } finally { verify.db.close(); }
  });

  test("heartbeat:during-task executes a REAL lease takeover whose fencing rejects the old owner", async () => {
    const { runId, dbPath, harness } = await openSeededDb(`heartbeat-during-${label}`, M);
    const result = await runScenario(scenario("heartbeat-during", { steps: [step("heartbeatRun", { input: { runId, runtimeOwnerId: "owner", heartbeatAtMs: now + 50 } })], faults: [fault("probe", "during-task", "heartbeat")] }), { harness });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const leaseLost = result.ambiguity.find((item) => item.outcome === "lease-lost");
    expect(leaseLost).toBeDefined();
    // The ambiguity must be the EXECUTED production takeover, not a fault echo.
    expect(leaseLost?.details.winner).toBe("lease-takeover");
    expect(leaseLost?.details.previousOwner).toBe("owner");
    expect(leaseLost?.details.fencingOwner).toBe("testing-fencing-owner");
    const receipt = lastReceipt(result);
    expect(receipt?.productionOperation).toBe("heartbeatRun");
    expect(receipt?.invoked).toBe(true);
    const takeover = receipt?.observation?.observed?.leaseTakeover;
    expect(takeover?.executed).toBe(true);
    expect(takeover?.oldOwnerHeartbeatRejected).toBe(true);
    const verify = await reopen(dbPath);
    try {
      // A lease-lost claim without durable fencing is a false state: the run's
      // owner must genuinely be the fencing owner, and a fresh old-owner
      // heartbeat through the PRODUCTION predicate must be rejected.
      const run = await verify.getRun(runId);
      expect(run?.runtimeOwnerId).toBe("testing-fencing-owner");
      expect(run?.runtimeOwnerId).not.toBe("owner");
      await verify.heartbeatRun(runId, "owner", now + 999);
      expect((await verify.getRun(runId))?.heartbeatAtMs).not.toBe(now + 999);
    } finally { verify.db.close(); }
  });

  test("lease-lost is never emitted from the declaration alone: a successful un-fenced heartbeat has no ambiguity", async () => {
    // Same declared fault, but the adapter cannot execute a takeover because
    // the run is already terminal (claimRunForResume's status predicate
    // rejects) — the middleware must then refuse to claim lease loss.
    const { runId, dbPath, harness, resource } = await openSeededDb(`heartbeat-no-fence-${label}`, M);
    await resource.completeRun(runId, "owner", now - 50_000);
    const result = await runScenario(scenario("heartbeat-no-fence", { steps: [step("heartbeatRun", { input: { runId, runtimeOwnerId: "owner", heartbeatAtMs: now + 50 } })], faults: [fault("probe", "during-task", "heartbeat")] }), { harness });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    expect(result.ambiguity.some((item) => item.outcome === "lease-lost")).toBe(false);
    const verify = await reopen(dbPath);
    try { expect((await verify.getRun(runId))?.runtimeOwnerId).toBeFalsy(); } finally { verify.db.close(); }
  });

  test("cancellation:during-task executes the REAL completion CAS race against the committed cancel", async () => {
    const { runId, dbPath, harness } = await openSeededDb(`cancel-during-${label}`, M);
    const result = await runScenario(scenario("cancel-during", { steps: [step("requestRunCancel", { input: { runId, cancelRequestedAtMs: now + 60 } })], faults: [fault("probe", "during-task", "cancellation")] }), { harness });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const raceAmbiguity = result.ambiguity.find((item) => item.outcome === "cancellation-race");
    expect(raceAmbiguity).toBeDefined();
    expect(raceAmbiguity?.details.winner).toBe("cancellation");
    const receipt = lastReceipt(result);
    expect(receipt?.productionOperation).toBe("requestRunCancel");
    expect(receipt?.invoked).toBe(true);
    const race = receipt?.observation?.observed?.cancellationRace;
    expect(race?.executed).toBe(true);
    expect(race?.cancelRequested).toBe(true);
    expect(race?.completionRejected).toBe(true);
    const verify = await reopen(dbPath);
    try {
      // The production CAS admitted exactly one winner: the cancel request is
      // durable and completion stayed fenced out (still not finished).
      const run = await verify.getRun(runId);
      expect(run?.cancelRequestedAtMs).toBe(now + 60);
      expect(run?.status).not.toBe("finished");
      expect(await verify.completeRun(runId, "owner", now + 70)).toBe(false);
    } finally { verify.db.close(); }
  });

  test("non-occurrence: a declared cut point whose operation never transitions stays inert on the real adapter", async () => {
    const { runId, dbPath, harness } = await openSeededDb(`non-occurrence-${label}`, M);
    const result = await runScenario(scenario("non-occurrence", { steps: [step("claimAttemptCompletion", { input: casInput(runId, now + 4) })], faults: [fault("probe", "during-task", "heartbeat")] }), { harness });
    expect(result.status).toBe("finished");
    expect(result.outputs.claimAttemptCompletion).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.ambiguity).toEqual([]);
    expect(result.trace.some((event) => event.type === "durability")).toBe(false);
    const verify = await reopen(dbPath);
    try { expect((await verify.getAttempt(runId, "node", 0, 1))?.state).toBe("finished"); } finally { verify.db.close(); }
  });

  test("unsupported pair fails admission on the real adapter before opening the database", async () => {
    let opened = 0;
    const adapter = realDbAdapter({ open: async () => { opened++; throw new Error("must not open"); } });
    const result = await runScenario(scenario("unsupported", { steps: [step("claimAttemptCompletion", { input: casInput("never", now) })], faults: [fault("probe", "during-task", "lease")] }), { harness: integrationHarness({ adapter }) });
    expect(result.status).toBe("capability-failure");
    expect(result.error?.code).toBe("ADMISSION_FAILED");
    expect(opened).toBe(0);
  });
});

const processReceipt = (result: ScenarioResult) => {
  const events = result.trace.filter((event) => event.type === "durability");
  return (events.at(-1)?.data as { receipt?: { stepId?: string; faultId?: string; productionOperation?: string; invoked?: boolean; adapter?: string; observation?: { terminatedBy?: string; resumed?: boolean; preKillEffectApplied?: boolean; journalWritten?: boolean; resumedStatus?: string; resumedOutputPersisted?: boolean } } } | undefined)?.receipt;
};

for (const { label, M } of ENTRYPOINTS) describe(`real-process adapter cut-point invocation (${label} entrypoint)`, () => {
  const { runScenario, scenario, step, fault, e2eHarness, integrationHarness, realDbAdapter, realProcessAdapter } = M;

  test("resume:during-task fires through the unified middleware at the REAL runWorkflow transition", async () => {
    const fixture = makeEngineChildFixture(`testing-cutpoint-occ-${label}`);
    try {
      const adapter = realProcessAdapter({ runnerPath: fixture.runnerPath, probe: fixture.probe, spawn: fixture.spawn });
      const result = await runScenario(scenario("process-occurrence", { steps: [step("work")], faults: [fault("sigkill", "during-task", "resume")] }), { harness: e2eHarness({ adapter }), waitBudget: 90_000 });
      expect(result.status).toBe("finished");
      // The durability receipt is emitted by the ONE operation/phase
      // middleware around the production runWorkflow transition, carrying the
      // adapter's native observation — not by a post-hoc side channel.
      const receipt = processReceipt(result as ScenarioResult);
      expect(receipt?.stepId).toBe("work");
      expect(receipt?.faultId).toBe("sigkill");
      expect(receipt?.productionOperation).toBe("runWorkflow");
      expect(receipt?.invoked).toBe(true);
      expect(receipt?.adapter).toBe("real-process:child");
      expect(receipt?.observation?.terminatedBy).toBe("SIGKILL");
      expect(receipt?.observation?.resumed).toBe(true);
      expect(receipt?.observation?.resumedStatus).toBe("finished");
      // The fault was injected while the production operation was genuinely
      // in flight: node B had started but no output row was committed yet.
      expect(receipt?.observation?.preKillEffectApplied).toBe(true);
      expect(receipt?.observation?.journalWritten).toBe(false);
      expect(result.ambiguity.some((item) => item.outcome === "restart-in-task")).toBe(true);
      expect(result.ambiguity.some((item) => item.outcome === "effect-applied-journal-missing")).toBe(true);
      // Real children, not simulations. Admission ran only the PROBE child
      // (clean exit, no workflow); runStep started the target runWorkflow
      // child that observed its SIGKILL terminal signal; the resumed child is
      // a distinct pid that exited cleanly after finishing the production run.
      expect(fixture.children).toHaveLength(3);
      expect(fixture.children[0]?.exitCode).toBe(0);
      expect(fixture.children[1]?.signalCode).toBe("SIGKILL");
      expect(fixture.children[2]?.exitCode).toBe(0);
      expect(fixture.children[1]?.pid).not.toBe(fixture.children[2]?.pid);
      const durable = await fixture.observe();
      expect(durable.journalWritten).toBe(true);
      expect(durable.outputPersisted).toBe(true);
    } finally { fixture.dispose(); }
  }, { timeout: 120_000 });

  test("non-occurrence: an admitted resume:during-task stays inert when no runWorkflow transition executes", async () => {
    const fixture = makeEngineChildFixture(`testing-cutpoint-inert-${label}`);
    try {
      const adapter = realProcessAdapter({ runnerPath: fixture.runnerPath, probe: fixture.probe, spawn: fixture.spawn });
      const result = await runScenario(scenario("process-inert", { steps: [], faults: [fault("sigkill", "during-task", "resume")] }), { harness: e2eHarness({ adapter }), waitBudget: 60_000 });
      expect(result.status).toBe("finished");
      expect(result.error).toBeUndefined();
      expect(result.ambiguity).toEqual([]);
      expect(result.trace.some((event) => event.type === "durability")).toBe(false);
      expect(result.trace.some((event) => event.type === "fault")).toBe(false);
      // Admission ran ONLY the identity/liveness probe child, which exited
      // cleanly on its own. No target runWorkflow execution happened: no
      // B.started marker, no workflow child, no attempt or output rows.
      expect(fixture.children).toHaveLength(1);
      expect(fixture.children[0]?.exitCode).toBe(0);
      expect(fixture.children[0]?.signalCode).toBeNull();
      expect(existsSync(fixture.startedMarker)).toBe(false);
      expect(await fixture.observe()).toEqual({ effectApplied: false, journalWritten: false, outputPersisted: false });
    } finally { fixture.dispose(); }
  }, { timeout: 90_000 });

  test("unsupported pairs fail admission across adapters before opening any real resource", async () => {
    let opened = 0;
    let spawned = 0;
    let probed = 0;
    const dbAdapter = realDbAdapter({ open: async () => { opened++; throw new Error("must not open"); } });
    const processPairOnDb = await runScenario(scenario("db-cannot-execute-process-pair", { steps: [step("noop")], faults: [fault("probe", "during-task", "resume")] }), { harness: integrationHarness({ adapter: dbAdapter }) });
    expect(processPairOnDb.status).toBe("capability-failure");
    expect(processPairOnDb.error?.code).toBe("ADMISSION_FAILED");
    const processAdapter = realProcessAdapter({ runnerPath: "/tmp/testing-cutpoint-not-a-runner.ts", probe: async () => { probed++; throw new Error("must not probe"); }, spawn: async () => { spawned++; throw new Error("must not spawn"); } });
    const dbPairOnProcess = await runScenario(scenario("process-cannot-execute-db-pair", { steps: [step("noop")], faults: [fault("probe", "during-task", "heartbeat")] }), { harness: e2eHarness({ adapter: processAdapter }) });
    expect(dbPairOnProcess.status).toBe("capability-failure");
    expect(dbPairOnProcess.error?.code).toBe("ADMISSION_FAILED");
    expect(opened).toBe(0);
    expect(spawned).toBe(0);
    expect(probed).toBe(0);
  });
});

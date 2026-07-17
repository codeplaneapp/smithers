import { e2eHarness, integrationHarness, makeHarness, unitSimHarness, type HarnessAdapter } from "./Harness.ts";

const adapter: HarnessAdapter = { identity: "fixture", verifiedProductionIdentity: "fixture", admissionProbe: () => undefined, runStep: () => undefined };
const unit = unitSimHarness({ name: "unit" });
const db = integrationHarness({ adapter, dbPath: "/tmp/test.db", retryProfile: {} });
const process = e2eHarness({ adapter, workflowEntry: "entry", dbPath: "/tmp/test.db", killSignal: "SIGKILL", resumeOwner: "owner" });
const literal = makeHarness("integration-real-db", { adapter, dbPath: "/tmp/test.db" });
void unit.config.name; void db.config.dbPath; void process.config.workflowEntry; void literal.config.dbPath;

// These assertions are deliberately compiled as part of the package typecheck.
// @ts-expect-error real-db-only configuration is not accepted by unit-sim.
unitSimHarness({ dbPath: "/tmp/not-allowed.db" });
// @ts-expect-error process-only configuration is not accepted by integration-real-db.
integrationHarness({ adapter, workflowEntry: "not-allowed" });
// @ts-expect-error unknown keys are rejected on the strict literal overload.
makeHarness("e2e-real-process", { adapter, unknownKey: true });

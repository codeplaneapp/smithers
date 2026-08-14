export { auto, fakeAgent, isAuto } from "./fakeAgent.ts";
export type {
  AutoMock,
  FakeAgent,
  FakeAgentCall,
  FakeAgentFiles,
  FakeAgentOptions,
  FakeAgentResult,
  FakeAgentScript,
  SafeSchema,
} from "./fakeAgent.ts";
export { renderWorkflow } from "./renderWorkflow.ts";
export type { RenderedWorkflow, RenderWorkflowOptions } from "./renderWorkflow.ts";
export { renderPrompt } from "./renderPrompt.ts";
export { runTask } from "./runTask.ts";
export type { RunTaskOptions } from "./runTask.ts";
export { simulate } from "./simulate.ts";
export type { Sim, SimTaskRecord, SimulateMockFunction, SimulateOptions } from "./simulate.ts";
export { coverWorkflow, expectFullCoverage, WorkflowCoverageError } from "./coverWorkflow.ts";
export type {
  CoverableWorkflow,
  WorkflowCoverageApproval,
  WorkflowCoverageApprovalResolver,
  WorkflowCoverageApprovalValue,
  WorkflowCoverageDecision,
  WorkflowCoverageEventContext,
  WorkflowCoverageEventResolver,
  WorkflowCoverageFailure,
  WorkflowCoverageOptions,
  WorkflowCoveragePass,
  WorkflowCoverageResult,
  WorkflowCoverageTaskContext,
  WorkflowCoverageValidation,
} from "./coverWorkflow.ts";
export { simMatchers, toHaveExecuted, toHaveExecutedInOrder, toHaveFinished } from "./matchers.ts";

export {
  AGENT_TRACE_VECTOR_VERSION,
  flattenGeneratePrompt,
  loadAgentTraceVector,
  parseAgentTraceVector,
  selectTurn,
} from "./agentTraceVector.ts";
export type {
  AgentTraceStreamEvent,
  AgentTraceTurn,
  AgentTraceTurnResult,
  AgentTraceTurnWhen,
  AgentTraceVector,
} from "./agentTraceVector.ts";

export { createVirtualClock } from "./virtualClock.ts";
export type {
  CreateVirtualClockOptions,
  VirtualClock as CampaignVirtualClock,
  VirtualClockMode,
} from "./virtualClock.ts";

export { scriptedAgent } from "./scriptedAgent.ts";
export type { ScriptedAgent, ScriptedAgentOptions } from "./scriptedAgent.ts";

export { scenario, step, barrier, fault, extension } from "./scenario/builder.ts";
export type { TaskRuntime, StepRunner } from "./scenario/builder.ts";
export { compileScenario } from "./scenario/compile.ts";
export type { CompileDiagnostic, CompileResult } from "./scenario/compile.ts";
export { canonicalize, CanonicalizeError } from "./scenario/canonicalize.ts";
export { replayIdentity } from "./scenario/replayIdentity.ts";
export type {
  ScenarioAst,
  ScenarioBarrier,
  ScenarioExtension,
  ScenarioFault,
  ScenarioStep,
  ScenarioValue,
} from "./scenario/ast.ts";
export type { ControlMessage } from "./control/ControlMessage.ts";
export type { TraceEvent } from "./trace/TraceEvent.ts";
export { VirtualClock } from "./kernel/VirtualClock.ts";
export { SeededScheduler } from "./kernel/SeededScheduler.ts";
export { ControlBus } from "./kernel/ControlBus.ts";
export { TraceCollector } from "./kernel/TraceCollector.ts";
export { BoundedWaitError, boundedWait } from "./kernel/BoundedWait.ts";
export type { HarnessError } from "./kernel/boundary.ts";
export { makeHarness, unitSimHarness, integrationHarness, e2eHarness } from "./harness/Harness.ts";
export type { AdapterFaultContext, HarnessAdapter } from "./harness/Harness.ts";
export { e2eDescriptor } from "./harness/e2eDescriptor.ts";
export type {
  E2eRealProcessHarnessConfig,
  Harness,
  HarnessConfig,
  HarnessKind,
  IntegrationRealDbHarnessConfig,
  UnitSimHarnessConfig,
} from "./harness/Harness.ts";
export type { Capability, CapabilityDecision } from "./harness/capabilities.ts";
export { requiredCapabilities } from "./harness/capabilities.ts";
export {
  SimulationError,
  simulationNativeError,
  simulationSmithersError,
  serializeBoundaryError,
  serializeSimulationDurableError,
} from "./harness/errors.ts";
export type { SimulationNativeErrorSpec } from "./harness/errors.ts";

export { runScenario, runKernelScenario, runWorkflowScenario } from "./runScenario.ts";
export type {
  RunScenarioOptions,
  ScenarioResult,
  RunWorkflowScenarioOptions,
  WorkflowScenarioResult,
  ScenarioWorkflow,
} from "./runScenario.ts";
export { dryRun } from "./dryRun.ts";
export { ambiguity } from "./durability/ambiguity.ts";
export type { AmbiguityOutcome, AmbiguityResult } from "./durability/ambiguity.ts";
export { JournalModel } from "./durability/journalModel.ts";
export { cutPoint } from "./durability/cutPoints.ts";
export type { DurabilityCutPoint, DurabilityOperation, DurabilityPhase } from "./durability/cutPoints.ts";
export { EffectLedger, mediatedEffect } from "./effects/mediatedEffects.ts";
export { opaqueEffect, isOpaqueEffect } from "./effects/opaque.ts";
export type { EffectOutcome, EffectRequest } from "./effects/mediatedEffects.ts";
export { contractProbe } from "./probes/contractProbe.ts";
export type { ProbeReport } from "./probes/contractProbe.ts";
export { boundaryShape, compareBoundaryShape } from "./probes/compareBoundaryShape.ts";
export type { BoundaryShape } from "./probes/compareBoundaryShape.ts";
export { CleanupScope } from "./cleanup/CleanupScope.ts";
export { assertNoLeaks } from "./cleanup/leakAssertions.ts";
export {
  expectEffect,
  expectTrace,
  expectAmbiguity,
  ExactlyOnceUnsupportedError,
} from "./assertions/effectAssertions.ts";
export { makeReplayBundle, serializeReplayBundle, loadReplayBundle, replayBundle } from "./replay/ReplayBundle.ts";
export type { ReplayBundle } from "./replay/ReplayBundle.ts";
export { firstDivergence } from "./replay/firstDivergence.ts";
export { shrink } from "./replay/shrink.ts";
export { realDbAdapter } from "./adapters/realDbAdapter.ts";
export type { RealDbAdapterOptions, RealDbResource } from "./adapters/realDbAdapter.ts";
export { realDbCutPoints } from "./adapters/realDbCutPoints.ts";
export type {
  ClaimAttemptCompletionInput,
  ClaimRunForResumeInput,
  HeartbeatRunInput,
  RealDbOperationMap,
} from "./adapters/realDbCutPoints.ts";
export { realProcessAdapter } from "./adapters/realProcessAdapter.ts";
export type {
  RealProcessAdapterOptions,
  RealProcessObservation,
  RealProcessResource,
} from "./adapters/realProcessAdapter.ts";

export {
  expectEventCount,
  expectNodeState,
  expectNodeStates,
  expectSteerConsumed,
  expectRunStatus,
  expectSoftPinBoard,
  tallyNodeStates,
} from "./scenarioAssert.ts";
export type { ScenarioAdapter } from "./scenarioAssert.ts";

export { runMaybeEffect } from "./runEffect.ts";

export {
  tryCreateHerdrBridge,
  tryOpenHerdrClient,
  snapshotHerdrWorkspace,
  assertHerdrBridge,
  tryCloseHerdrWorkspacesForRun,
  tryCloseCampaignHerdrWorkspaces,
  focusHerdrWorkspaceByLabel,
  isCampaignWorkspaceLabel,
} from "./herdrBridge.ts";
export type {
  HerdrBridge,
  HerdrBridgeClient,
  HerdrBridgeOptions,
  HerdrWorkspaceSnapshot,
  HerdrAssertOptions,
} from "./herdrBridge.ts";

export { runCampaign } from "./campaign.ts";
export type {
  CampaignScenario,
  CampaignRunContext,
  CampaignScenarioResult,
  CampaignReport,
  RunCampaignOptions,
} from "./campaign.ts";

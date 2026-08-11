// @smithers-type-exports-begin
/** @typedef {import("./HerdrClientOptions.ts").HerdrClientOptions} HerdrClientOptions */
/** @typedef {import("./HerdrClientOptions.ts").HerdrPingOptions} HerdrPingOptions */
/** @typedef {import("./HerdrClientOptions.ts").HerdrClient} HerdrClient */
/** @typedef {import("./HerdrClientOptions.ts").HerdrLogger} HerdrLogger */
/** @typedef {import("./HerdrClientOptions.ts").HerdrLogLevel} HerdrLogLevel */
/** @typedef {import("./HerdrClientOptions.ts").HerdrEvent} HerdrEvent */
/** @typedef {import("./HerdrClientOptions.ts").HerdrSubscription} HerdrSubscription */
/** @typedef {import("./HerdrClientOptions.ts").HerdrSubscriptionHandle} HerdrSubscriptionHandle */
/** @typedef {import("./HerdrProtocol.ts").HerdrAgentState} HerdrAgentState */
/** @typedef {import("./HerdrProtocol.ts").HerdrAgentStatus} HerdrAgentStatus */
/** @typedef {import("./HerdrProtocol.ts").HerdrReadSource} HerdrReadSource */
/** @typedef {import("./HerdrProtocol.ts").HerdrReadFormat} HerdrReadFormat */
/** @typedef {import("./HerdrProtocol.ts").HerdrSplitDirection} HerdrSplitDirection */
/** @typedef {import("./HerdrProtocol.ts").HerdrMetadataTokens} HerdrMetadataTokens */
/** @typedef {import("./HerdrProtocol.ts").HerdrToastPosition} HerdrToastPosition */
/** @typedef {import("./HerdrProtocol.ts").HerdrNotificationSound} HerdrNotificationSound */
/** @typedef {import("./HerdrProtocol.ts").HerdrOutputMatch} HerdrOutputMatch */
/** @typedef {import("./HerdrProtocol.ts").HerdrPong} HerdrPong */
/** @typedef {import("./HerdrProtocol.ts").HerdrServerCapabilities} HerdrServerCapabilities */
/** @typedef {import("./HerdrProtocol.ts").HerdrWorkspaceInfo} HerdrWorkspaceInfo */
/** @typedef {import("./HerdrProtocol.ts").HerdrTabInfo} HerdrTabInfo */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneInfo} HerdrPaneInfo */
/** @typedef {import("./HerdrProtocol.ts").HerdrAgentInfo} HerdrAgentInfo */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneReadResult} HerdrPaneReadResult */
/** @typedef {import("./HerdrProtocol.ts").HerdrWorkspaceCreateParams} HerdrWorkspaceCreateParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrWorkspaceCreateResult} HerdrWorkspaceCreateResult */
/** @typedef {import("./HerdrProtocol.ts").HerdrWorkspaceCloseParams} HerdrWorkspaceCloseParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrWorkspaceRenameParams} HerdrWorkspaceRenameParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrWorkspaceRenameResult} HerdrWorkspaceRenameResult */
/** @typedef {import("./HerdrProtocol.ts").HerdrWorkspaceListResult} HerdrWorkspaceListResult */
/** @typedef {import("./HerdrProtocol.ts").HerdrOkResult} HerdrOkResult */
/** @typedef {import("./HerdrProtocol.ts").HerdrTabCreateParams} HerdrTabCreateParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrTabCreateResult} HerdrTabCreateResult */
/** @typedef {import("./HerdrProtocol.ts").HerdrAgentStartParams} HerdrAgentStartParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrAgentStartResult} HerdrAgentStartResult */
/** @typedef {import("./HerdrProtocol.ts").HerdrAgentListResult} HerdrAgentListResult */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneListParams} HerdrPaneListParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneListResult} HerdrPaneListResult */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneReportAgentParams} HerdrPaneReportAgentParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneReportAgentSessionParams} HerdrPaneReportAgentSessionParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneReleaseAgentParams} HerdrPaneReleaseAgentParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneReportMetadataParams} HerdrPaneReportMetadataParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneSendInputParams} HerdrPaneSendInputParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneReadParams} HerdrPaneReadParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneReadResultEnvelope} HerdrPaneReadResultEnvelope */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneWaitForOutputParams} HerdrPaneWaitForOutputParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrPaneWaitForOutputResult} HerdrPaneWaitForOutputResult */
/** @typedef {import("./HerdrProtocol.ts").HerdrNotificationShowParams} HerdrNotificationShowParams */
/** @typedef {import("./HerdrProtocol.ts").HerdrNotificationShowResult} HerdrNotificationShowResult */
/** @typedef {import("./HerdrRunSurface.ts").HerdrRunSurfaceOptions} HerdrRunSurfaceOptions */
/** @typedef {import("./HerdrRunSurface.ts").HerdrRunSurface} HerdrRunSurface */
/** @typedef {import("./HerdrRunSurface.ts").SmithersEventLike} SmithersEventLike */
/** @typedef {import("./HerdrRunSurface.ts").AgentCliEventLike} AgentCliEventLike */
/** @typedef {import("./HerdrRunSurface.ts").HijackLaunchSpec} HijackLaunchSpec */
/** @typedef {import("./HerdrRunSurface.ts").HijackPaneContext} HijackPaneContext */
/** @typedef {import("./HerdrRunSurface.ts").HijackPaneResult} HijackPaneResult */
// @smithers-type-exports-end

export { HERDR_PROTOCOL } from "./HERDR_PROTOCOL.js";
export { HerdrError } from "./HerdrError.js";
export { createHerdrClient, normalizeHerdrEventName } from "./createHerdrClient.js";
export {
  createHerdrRunSurface,
  HERDR_SURFACE_EVENT_TYPES,
  launchHijackPane,
  openTabPane,
  OUTCOME_MARKERS,
  outcomeMarkerFor,
  shortNodeId,
  shortRunId,
  stripOutcomeMarker,
  workspaceLabelMatches,
} from "./createHerdrRunSurface.js";
export {
  DEFAULT_SOFT_PIN_SLOTS,
  gateTabLabel,
  isLikelyWorkerNodeId,
  isPinnedNodeId,
  resolveAutoOpenPolicy,
  resolveSoftPinSlots,
  shouldAutoOpenDetailTab,
  updateSoftPinSet,
} from "./cockpitPolicy.js";
export {
  DEFAULT_HARNESS_CANDIDATES,
  detectHarnessCommand,
  isExecutableOnPath,
  resolveHarnessCommand,
  shouldDockIntoCurrentPane,
  shouldSplitCockpit,
} from "./cockpitLayout.js";
export {
  DEFAULT_DIGEST_INTERVAL_MS,
  buildDigestBlock,
  buildFleetStrip,
  digestSignature,
  formatClockHm,
  formatElapsed,
} from "./digest.js";
export {
  defaultSessionNameForRun,
  isStubWorkspaceLabel,
  sessionAttachHint,
  stubWorkspaceLabel,
} from "./sessionLifecycle.js";
export { resolveSocketPath, sessionSocketPath } from "./resolveSocketPath.js";

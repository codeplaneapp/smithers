import { aD as SmithersMetricDefinition$1, c as SmithersMetricDefinition$2, aE as SmithersMetricType$1, aF as SmithersMetricUnit$1 } from '../rewindSandboxesReverted-DcBmlYff.js';
export { d as activeNodes, e as activeRuns, f as approvalPending, g as approvalWaitDuration, h as approvalsDenied, i as approvalsGranted, j as approvalsRequested, k as attemptDuration, l as cacheHits, m as cacheMisses, n as dbQueryDuration, o as dbRetries, p as dbTransactionDuration, q as dbTransactionRetries, r as dbTransactionRollbacks, s as errorsTotal, t as eventsEmittedTotal, u as externalWaitAsyncPending, v as hotReloadDuration, w as hotReloadFailures, x as hotReloads, y as httpRequestDuration, z as httpRequests, A as metricsServiceAdapter, B as nodeDuration, C as nodeRetriesTotal, D as nodesFailed, E as nodesFinished, F as nodesStarted, G as processHeapUsedBytes, H as processMemoryRssBytes, I as processUptimeSeconds, J as promptSizeBytes, K as replaysStarted, L as responseSizeBytes, N as rewindDurationMs, O as rewindFramesDeleted, P as rewindRollbackTotal, Q as rewindSandboxesReverted, R as rewindTotal, T as runDuration, U as runForksCreated, V as runsAncestryDepth, W as runsCancelledTotal, X as runsCarriedStateBytes, Y as runsContinuedTotal, Z as runsFailedTotal, _ as runsFinishedTotal, $ as runsResumedTotal, a0 as runsTotal, a1 as sandboxActive, a2 as sandboxBundleSizeBytes, a3 as sandboxCompletedTotal, a4 as sandboxCreatedTotal, a5 as sandboxDurationMs, a6 as sandboxPatchCount, a7 as sandboxTransportDurationMs, a8 as schedulerConcurrencyUtilization, a9 as schedulerQueueDepth, aa as schedulerWaitDuration, ab as scorerEventsFailed, ac as scorerEventsFinished, ad as scorerEventsStarted, ae as smithersMetricCatalog, af as snapshotDuration, ag as snapshotsCaptured, ah as timerDelayDuration, ai as timersCancelled, aj as timersCreated, ak as timersFired, al as timersPending, am as toPrometheusMetricName, an as tokensCacheReadTotal, ao as tokensCacheWriteTotal, ap as tokensContextWindowBucketTotal, aq as tokensContextWindowPerCall, ar as tokensInputPerCall, as as tokensInputTotal, at as tokensOutputPerCall, au as tokensOutputTotal, av as tokensReasoningTotal, aw as toolCallErrorsTotal, ax as toolCallsTotal, ay as toolDuration, az as toolOutputTruncatedTotal, aA as trackEvent, aB as updateProcessMetrics, aC as vcsDuration } from '../rewindSandboxesReverted-DcBmlYff.js';
import * as effect from 'effect';
import { Effect, Metric } from 'effect';

/**
 * @param {"approval" | "event"} kind
 * @param {number} delta
 * @returns {Effect.Effect<void>}
 */
declare function updateAsyncExternalWaitPending(kind: "approval" | "event", delta: number): Effect.Effect<void>;

declare const smithersMetricCatalogByKey: Map<string, SmithersMetricDefinition$1>;

declare const smithersMetricCatalogByName: Map<string, SmithersMetricDefinition$1>;

declare const smithersMetricCatalogByPrometheusName: Map<string, SmithersMetricDefinition$1>;

declare const alertsFiredTotal: Metric.Counter<number>;

declare const alertsAcknowledgedTotal: Metric.Counter<number>;

declare const alertsResolvedTotal: Metric.Counter<number>;

declare const alertsSilencedTotal: Metric.Counter<number>;

declare const alertsReopenedTotal: Metric.Counter<number>;

declare const alertsEscalatedTotal: Metric.Counter<number>;

declare const alertDeliveriesAttempted: Metric.Counter<number>;

declare const alertDeliveriesSuppressed: Metric.Counter<number>;

declare const supervisorPollsTotal: Metric.Counter<number>;

declare const supervisorStaleDetected: Metric.Counter<number>;

declare const supervisorResumedTotal: Metric.Counter<number>;

declare const supervisorSkippedTotal: Metric.Counter<number>;

declare const agentInvocationsTotal: Metric.Counter<number>;

declare const agentTokensTotal: Metric.Counter<number>;

declare const agentErrorsTotal: Metric.Counter<number>;

declare const agentRetriesTotal: Metric.Counter<number>;

declare const agentEventsTotal: Metric.Counter<number>;

declare const agentSessionsTotal: Metric.Counter<number>;

declare const agentActionsTotal: Metric.Counter<number>;

declare const gatewayConnectionsTotal: Metric.Counter<number>;

declare const gatewayConnectionsClosedTotal: Metric.Counter<number>;

declare const gatewayMessagesReceivedTotal: Metric.Counter<number>;

declare const gatewayMessagesSentTotal: Metric.Counter<number>;

declare const gatewayRpcCallsTotal: Metric.Counter<number>;

declare const gatewayErrorsTotal: Metric.Counter<number>;

declare const gatewayRunsStartedTotal: Metric.Counter<number>;

declare const gatewayRunsCompletedTotal: Metric.Counter<number>;

declare const gatewayApprovalDecisionsTotal: Metric.Counter<number>;

declare const gatewaySignalsTotal: Metric.Counter<number>;

declare const gatewayAuthEventsTotal: Metric.Counter<number>;

declare const gatewayHeartbeatTicksTotal: Metric.Counter<number>;

declare const gatewayCronTriggersTotal: Metric.Counter<number>;

declare const gatewayWebhooksReceivedTotal: Metric.Counter<number>;

declare const gatewayWebhooksVerifiedTotal: Metric.Counter<number>;

declare const gatewayWebhooksRejectedTotal: Metric.Counter<number>;

declare const devtoolsSubscribeTotal: Metric.Counter<number>;

declare const devtoolsEventTotal: Metric.Counter<number>;

declare const devtoolsBackpressureDisconnectTotal: Metric.Counter<number>;

declare const gatewayRunEventBackpressureDisconnectTotal: Metric.Counter<number>;

declare const taskHeartbeatsTotal: Metric.Counter<number>;

declare const taskHeartbeatTimeoutTotal: Metric.Counter<number>;

declare const memoryFactReads: Metric.Counter<number>;

declare const memoryFactWrites: Metric.Counter<number>;

declare const memoryRecallQueries: Metric.Counter<number>;

declare const memoryMessageSaves: Metric.Counter<number>;

declare const openApiToolCallsTotal: Metric.Counter<number>;

declare const openApiToolCallErrorsTotal: Metric.Counter<number>;

declare const scorersStarted: Metric.Counter<number>;

declare const scorersFinished: Metric.Counter<number>;

declare const scorersFailed: Metric.Counter<number>;

declare const alertsActive: Metric.Gauge<number>;

declare const attentionBacklog: Metric.Gauge<number>;

declare const gatewayConnectionsActive: Metric.Gauge<number>;

declare const devtoolsActiveSubscribers: Metric.Gauge<number>;

declare const agentDurationMs: Metric.Histogram<number>;

declare const gatewayRpcDuration: Metric.Histogram<number>;

declare const supervisorPollDuration: Metric.Histogram<number>;

declare const supervisorResumeLag: Metric.Histogram<number>;

declare const heartbeatDataSizeBytes: Metric.Histogram<number>;

declare const heartbeatIntervalMs: Metric.Histogram<number>;

declare const memoryRecallDuration: Metric.Histogram<number>;

/** @type {import("effect").Metric.Metric<import("effect/MetricKeyType").MetricKeyType.Histogram, number, import("effect/MetricState").MetricState.Histogram>} */
declare const openApiToolDuration: effect.Metric.Metric<any, number, any>;

declare const scorerDuration: Metric.Histogram<number>;

declare const devtoolsSnapshotBuildMs: Metric.Histogram<number>;

declare const devtoolsDeltaBuildMs: Metric.Histogram<number>;

declare const devtoolsEventBytes: Metric.Histogram<number>;

type SmithersMetricDefinition = SmithersMetricDefinition$2;
type SmithersMetricType = SmithersMetricType$1;
type SmithersMetricUnit = SmithersMetricUnit$1;

export { type SmithersMetricDefinition, type SmithersMetricType, type SmithersMetricUnit, agentActionsTotal, agentDurationMs, agentErrorsTotal, agentEventsTotal, agentInvocationsTotal, agentRetriesTotal, agentSessionsTotal, agentTokensTotal, alertDeliveriesAttempted, alertDeliveriesSuppressed, alertsAcknowledgedTotal, alertsActive, alertsEscalatedTotal, alertsFiredTotal, alertsReopenedTotal, alertsResolvedTotal, alertsSilencedTotal, attentionBacklog, devtoolsActiveSubscribers, devtoolsBackpressureDisconnectTotal, devtoolsDeltaBuildMs, devtoolsEventBytes, devtoolsEventTotal, devtoolsSnapshotBuildMs, devtoolsSubscribeTotal, gatewayApprovalDecisionsTotal, gatewayAuthEventsTotal, gatewayConnectionsActive, gatewayConnectionsClosedTotal, gatewayConnectionsTotal, gatewayCronTriggersTotal, gatewayErrorsTotal, gatewayHeartbeatTicksTotal, gatewayMessagesReceivedTotal, gatewayMessagesSentTotal, gatewayRpcCallsTotal, gatewayRpcDuration, gatewayRunEventBackpressureDisconnectTotal, gatewayRunsCompletedTotal, gatewayRunsStartedTotal, gatewaySignalsTotal, gatewayWebhooksReceivedTotal, gatewayWebhooksRejectedTotal, gatewayWebhooksVerifiedTotal, heartbeatDataSizeBytes, heartbeatIntervalMs, memoryFactReads, memoryFactWrites, memoryMessageSaves, memoryRecallDuration, memoryRecallQueries, openApiToolCallErrorsTotal, openApiToolCallsTotal, openApiToolDuration, scorerDuration, scorersFailed, scorersFinished, scorersStarted, smithersMetricCatalogByKey, smithersMetricCatalogByName, smithersMetricCatalogByPrometheusName, supervisorPollDuration, supervisorPollsTotal, supervisorResumeLag, supervisorResumedTotal, supervisorSkippedTotal, supervisorStaleDetected, taskHeartbeatTimeoutTotal, taskHeartbeatsTotal, updateAsyncExternalWaitPending };

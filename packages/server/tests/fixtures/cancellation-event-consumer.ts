import type { SmithersDevToolsOptions } from "@smthrs/devtools";
import type { RunCancellationSource, SmithersEvent } from "@smthrs/observability";

type DevToolsEngineEvent = Parameters<NonNullable<SmithersDevToolsOptions["onEngineEvent"]>>[0];
type ObservabilityRunCancelled = Extract<SmithersEvent, { type: "RunCancelled" }>;
type DevToolsRunCancelled = Extract<DevToolsEngineEvent, { type: "RunCancelled" }>;

const source: RunCancellationSource = {
  kind: "signal",
  detail: "worker received SIGTERM",
  signal: "SIGTERM",
  clientPid: 4321,
  requestId: "request-observability",
  clientIdentity: "operator",
};

const observabilityEvent: ObservabilityRunCancelled = {
  type: "RunCancelled",
  runId: "run-observability",
  timestampMs: 1,
  source,
};

const devtoolsEvent: DevToolsRunCancelled = {
  type: "RunCancelled",
  runId: "run-devtools",
  timestampMs: 2,
  source: {
    kind: "rpc",
    detail: "gateway HTTP cancellation request",
    clientPid: 5432,
    requestId: "request-devtools",
    clientIdentity: "user:operator",
  },
};

const observabilityKind: "signal" | "rpc" | "cli" | "engine" | undefined = observabilityEvent.source?.kind;
const devtoolsSignal: string | undefined = devtoolsEvent.source?.signal;

void [observabilityKind, devtoolsSignal];

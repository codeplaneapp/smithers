import type {
  GatewayApprovalSummary,
  GatewayEventFrame,
  GatewayResponseFrame,
  GatewayRpcMethod,
  GatewayTicketRow,
  LaunchRunRequest,
  RunStartedBy,
  ListApprovalsResponse,
  ListTicketsResponse,
  BrowserAction,
  BrowserClickAction,
  BrowserOutcome,
  BrowserContextSlice,
  BrowserScreenshot,
  BrowserSelection,
  BrowserActor,
  BrowserViewport,
  BrowserPoint,
  BrowserRectangle,
  BrowserModifier,
  BrowserRedaction,
  BrowserJournalEntry,
  BrowserActivityEvent,
  BrowserSummary,
} from "@smthrs/protocol/gateway-rpc";
import type { RunStartedBy as DriverRunStartedBy } from "@smthrs/driver";

const method: GatewayRpcMethod = "launchRun";
const request: LaunchRunRequest = {
  workflow: "deploy",
  input: { environment: "staging" },
  options: { startedBy: { harness: "codex", sessionId: "thread-1", detected: true } },
};
const protocolStartedBy: RunStartedBy = { harness: "codex", sessionId: "thread-1" };
const driverStartedBy: DriverRunStartedBy = protocolStartedBy;
const protocolRoundTrip: RunStartedBy = driverStartedBy;
const approval: GatewayApprovalSummary = {
  runId: "run-1",
  nodeId: "approve",
  iteration: 0,
  requestedAtMs: null,
};
const ticket: GatewayTicketRow = {
  path: "ticket-1",
  kind: "ticket",
  content: "Ship it",
  contentHash: "hash",
  updatedAtMs: 1,
};
const event: GatewayEventFrame<{ runId: string }> = {
  type: "event",
  event: "run.updated",
  payload: { runId: "run-1" },
  seq: 1,
  stateVersion: 1,
  apiVersion: "v1",
};
const response: GatewayResponseFrame<ListApprovalsResponse> = {
  type: "res",
  id: "request-1",
  ok: true,
  apiVersion: "v1",
  payload: [approval],
};
const tickets: ListTicketsResponse = [ticket];

void [method, request, protocolStartedBy, driverStartedBy, protocolRoundTrip, event, response, tickets];
const clickByLocator: BrowserClickAction = { kind: "click", locator: { role: "button" } };
const clickByPoint: BrowserClickAction = { kind: "click", point: { x: 1, y: 2 } };
const outcome: BrowserOutcome = { ok: true };
const slice: BrowserContextSlice = "screenshot";
const screenshot: BrowserScreenshot = { data: "jpeg", mediaType: "image/jpeg" };
const selection: BrowserSelection = {
  locator: { css: "button" },
  role: "button",
  name: "Go",
  text: "Go",
  fingerprint: "button:Go",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  viewport: { width: 100, height: 100 },
};
const action: BrowserAction = clickByLocator;
const actor: BrowserActor = "agent";
const viewport: BrowserViewport = { width: 100, height: 100 };
const point: BrowserPoint = { x: 1, y: 2 };
const rectangle: BrowserRectangle = { ...point, width: 10, height: 10 };
const modifier: BrowserModifier = "Control";
const redaction: BrowserRedaction = { redacted: true, length: 3 };
const journal: BrowserJournalEntry = { actionId: "a", actor, revision: 1, action, result: outcome };
const activity: BrowserActivityEvent = { sessionId: "s", actionId: "a", actor, revision: 1, action, result: outcome };
const summary: BrowserSummary = { count: 1 };
// @ts-expect-error click targets are mutually exclusive
const clickWithBoth: BrowserClickAction = { kind: "click", locator: { css: "button" }, point };
// @ts-expect-error click requires one target
const clickWithNeither: BrowserClickAction = { kind: "click" };
void [
  clickByPoint,
  outcome,
  slice,
  screenshot,
  selection,
  action,
  viewport,
  rectangle,
  modifier,
  redaction,
  journal,
  activity,
  summary,
  clickWithBoth,
  clickWithNeither,
];

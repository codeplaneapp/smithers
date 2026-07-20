import type {
  GatewayApprovalSummary,
  GatewayEventFrame,
  GatewayResponseFrame,
  GatewayRpcMethod,
  GatewayTicketRow,
  LaunchRunRequest,
  ListApprovalsResponse,
  ListTicketsResponse,
} from "@smithers-orchestrator/protocol/gateway-rpc";

const method: GatewayRpcMethod = "launchRun";
const request: LaunchRunRequest = {
  workflow: "deploy",
  input: { environment: "staging" },
};
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

void [method, request, event, response, tickets];

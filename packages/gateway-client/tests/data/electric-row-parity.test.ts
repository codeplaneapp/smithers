import { describe, expect, test } from "bun:test";
import {
  serializeApprovalRow,
  serializeCronRow,
  serializeDocRow,
  serializeMemoryFactRow,
  serializeRunEventRow,
  serializeRunRow,
  serializeScoreRow,
  serializeTicketRow,
} from "@smithers-orchestrator/gateway/api";
import { mapSmithersElectricRow } from "../../src/data/mapSmithersElectricRow.ts";

describe("Electric row-shape parity", () => {
  test("maps every Electric-backed REST collection row to the REST serializer shape", () => {
    const runRow = {
      run_id: "run-parity",
      workflow_name: "value",
      status: "completed",
      created_at_ms: 1718000000000,
      started_at_ms: 1718000000100,
      finished_at_ms: 1718000000200,
      config_json: JSON.stringify({ gatewayWorkflowKey: "value" }),
    };
    const eventRow = {
      run_id: "run-parity",
      seq: 7,
      type: "node.output",
      payload_json: JSON.stringify({ nodeId: "task1", value: 42 }),
      timestamp_ms: 1718000000300,
    };
    const approvalRow = {
      run_id: "run-parity",
      workflow_key: "value",
      node_id: "approval",
      iteration: 0,
      request_json: JSON.stringify({
        title: "Approve",
        summary: "Approve the action",
        mode: "manual",
        options: [{ id: "yes", label: "Yes" }],
        allowedScopes: ["run:write"],
        allowedUsers: ["user:operator"],
        autoApprove: false,
      }),
      requested_at_ms: 1718000000400,
    };
    const docRow = {
      path: "docs/readme.md",
      kind: "doc",
      content: "hello",
      content_hash: "hash-doc",
      updated_at_ms: 1718000000500,
    };
    const ticketRow = {
      path: "tickets/t-1.md",
      kind: "ticket",
      content: "fix it",
      content_hash: "hash-ticket",
      updated_at_ms: 1718000000600,
    };
    const scoreRow = {
      run_id: "run-parity",
      node_id: "task1",
      iteration: 0,
      attempt: 0,
      scorer_id: "score:exact",
      scorer_name: "Exact",
      source: "eval",
      score: 1,
      reason: null,
      scored_at_ms: 1718000000700,
      latency_ms: 12,
      duration_ms: 34,
    };
    const memoryRow = {
      namespace: "workspace",
      key: "preference",
      value_json: JSON.stringify({ theme: "plain" }),
      schema_sig: "sig-memory",
      created_at_ms: 1718000000800,
      updated_at_ms: 1718000000900,
      ttl_ms: null,
    };
    const cronRow = {
      cron_id: "cron-parity",
      pattern: "*/5 * * * *",
      workflow_path: "gateway:value",
      enabled: 1,
      created_at_ms: 1718000001000,
      last_run_at_ms: null,
      next_run_at_ms: 1718000002000,
      error_json: null,
    };

    expect(mapSmithersElectricRow("runs", runRow)).toEqual(serializeRunRow(runRow));
    expect(mapSmithersElectricRow("run", runRow)).toEqual(serializeRunRow(runRow));
    expect(mapSmithersElectricRow("events", eventRow)).toEqual(serializeRunEventRow(eventRow));
    expect(mapSmithersElectricRow("approvals", approvalRow)).toEqual(serializeApprovalRow(approvalRow));
    expect(mapSmithersElectricRow("docs", docRow)).toEqual(serializeDocRow(docRow));
    expect(mapSmithersElectricRow("tickets", ticketRow)).toEqual(serializeTicketRow(ticketRow));
    expect(mapSmithersElectricRow("scores", scoreRow)).toEqual(serializeScoreRow(scoreRow));
    expect(mapSmithersElectricRow("memoryFacts", memoryRow)).toEqual(serializeMemoryFactRow(memoryRow));
    expect(mapSmithersElectricRow("crons", cronRow)).toEqual(serializeCronRow(cronRow));
  });

  test("maps output-table rows to the GatewayRunNode row shape used by REST runTree", () => {
    expect(mapSmithersElectricRow("nodes", {
      run_id: "run-parity",
      node_id: "task1",
      iteration: 0,
      state: "completed",
      label: "Task one",
      output_table: "result",
    })).toEqual({
      key: "run-parity:task1:0",
      id: "task1",
      name: "Task one",
      cardLabel: "Task one",
      kind: "result",
      status: "completed",
      iteration: 0,
      childIds: [],
    });
  });
});

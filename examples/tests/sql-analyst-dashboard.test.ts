import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["inspect-schema", "plan-query", "write-sql", "check-sql", "execute-query", "make-dashboard"]) {
  mock.module(`../prompts/sql-analyst-dashboard/${name}.mdx`, () => ({ default: Prompt }));
}

const mocks = {
  "inspect-schema": { tables: [], joins: [] },
  "plan-query": {
    question: "Revenue?", requiredTables: ["orders"], metrics: ["revenue"], filters: [], risks: [],
  },
  "write-sql": { sql: "select 1 limit 10", rowLimit: 10, explanation: "safe" },
  "check-sql": ({ iteration }: { iteration: number }) => ({
    approved: iteration >= 1, readOnly: true, hasLimit: true, risk: "medium",
    safeSql: "select 1 limit 10", rejectedReasons: iteration >= 1 ? [] : ["review"],
  }),
  "execute-query": { columns: ["revenue"], rowsPreview: [{ revenue: 1 }], rowCount: 1, executionMs: 2 },
  "make-dashboard": {
    answer: "1", chartSpec: { type: "table" }, caveats: [], sqlUsed: "select 1 limit 10",
  },
};

test("covers SQL retries and both approval decisions", async () => {
  const approved = await coverExample("../sql-analyst-dashboard.jsx", {
    input: { question: "Revenue?" },
    mocks,
    approvals: true,
    maxLoopIterations: 3,
    expectedNodes: [
      "inspect-schema", "plan-query", "write-sql", "check-sql",
      "approve-query", "execute-query", "make-dashboard",
    ],
  });
  const denied = await coverExample("../sql-analyst-dashboard.jsx", {
    input: { question: "Revenue?" },
    mocks,
    approvals: false,
    maxLoopIterations: 3,
    assert: false,
  });

  expect(approved.executed).toEqual([
    "inspect-schema", "plan-query", "write-sql", "check-sql", "write-sql", "check-sql",
    "approve-query", "execute-query", "make-dashboard",
  ]);
  expect(denied.executed).toEqual([
    "inspect-schema", "plan-query", "write-sql", "check-sql", "write-sql", "check-sql",
    "approve-query",
  ]);
  expect(approved.taskOutputs["check-sql"]).toHaveLength(2);
  expect([approved.approvals[0].approved, denied.approvals[0].approved]).toEqual([true, false]);
  expect(denied.errors[0]).toMatchObject({
    code: "SESSION_ERROR", message: expect.stringContaining("approve-query"),
  });
}, 15_000);

import { describe, expect, test } from "bun:test";
import { ListRunDecisionsRouteError, listRunDecisionsRoute } from "../src/gatewayRoutes/listRunDecisions.js";

const adapter = (extra: Record<string, unknown> = {}) => ({
  listPendingApprovals: async () => [{ nodeId: "gate", iteration: 0, status: "requested", requestedAtMs: 20, requestJson: '{"title":"Ship?"}' }],
  listAllDecidedApprovals: async () => [{ nodeId: "gate", iteration: 0, status: "approved", requestedAtMs: 10, decidedAtMs: 30, decidedBy: "will", note: "ship it", decisionJson: '{"choice":"prod"}' }],
  listHumanRequestsForRun: async () => [{ nodeId: "ask", status: "answered", prompt: "Continue?", requestedAtMs: 5, answeredAtMs: 40, answeredBy: "cli", responseJson: '{"yes":true}' }],
  listMemoryFactsForRun: async () => [{ namespace: "run", key: "fact", valueJson: '"ok"', updatedAtMs: 15 }], ...extra,
});
const params = (overrides: Record<string, unknown> = {}) => ({ runId: "run-1", resolveRun: async () => ({ workflow: {}, adapter: adapter() }), ...overrides }) as any;

describe("listRunDecisionsRoute", () => {
  test("validates run ids and missing runs", async () => {
    await expect(listRunDecisionsRoute(params({ runId: "bad id" }))).rejects.toBeInstanceOf(ListRunDecisionsRouteError);
    await expect(listRunDecisionsRoute(params({ resolveRun: async () => null }))).rejects.toMatchObject({ code: "RunNotFound" });
  });
  test("merges durable sources chronologically and never uses cross-run facts", async () => {
    const a = adapter(); (a as any).listMemoryFacts = () => { throw new Error("wrong reader"); };
    const result = await listRunDecisionsRoute(params({ resolveRun: async () => ({ workflow: {}, adapter: a }) }));
    expect(result.entries.map((entry: any) => entry.kind)).toEqual(["ask-human", "approval", "memory", "approval"]);
    expect(result.entries[1].resolution.by).toBe("will");
    expect((result.entries[1].resolution as any).value).toEqual({ choice: "prod" });
    expect((result.entries[1].detail as any).decision).toEqual({ choice: "prod" });
  });
  test("reads complete snake_case and camelCase source rows", async () => {
    const a = adapter({
      listPendingApprovals: async () => [{ node_id: "gate", iteration: 2, status: "requested", requested_at_ms: 1, request_json: { summary: "Snake gate" } }],
      listAllDecidedApprovals: async () => [{ nodeId: "gate", iteration: 2, status: "denied", requestedAtMs: 2, decidedAtMs: 4, decidedBy: "operator", note: "hold", decisionJson: { option: "later" } }],
      listHumanRequestsForRun: async () => [{ node_id: "ask", status: "answered", prompt: "Snake ask", requested_at_ms: 3, answered_at_ms: 8, answered_by: "cli", response_json: { ok: true } }],
    });
    const result = await listRunDecisionsRoute(params({ resolveRun: async () => ({ workflow: {}, adapter: a }) }));
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Snake gate", nodeId: "gate" }),
      expect.objectContaining({ status: "denied", resolution: expect.objectContaining({ by: "operator", note: "hold", value: { option: "later" } }) }),
      expect.objectContaining({ title: "Snake ask", resolution: expect.objectContaining({ by: "cli", value: { ok: true } }) }),
    ]));
  });
  test("degrades adapters missing new readers", async () => {
    const a = adapter(); delete (a as any).listHumanRequestsForRun; delete (a as any).listMemoryFactsForRun;
    const result = await listRunDecisionsRoute(params({ resolveRun: async () => ({ workflow: {}, adapter: a }) }));
    expect(result.counts.askHuman).toBe(0); expect(result.counts.memory).toBe(0);
  });
  test("preserves primitive ask-human responses and memory facts", async () => {
    const a = adapter({
      listHumanRequestsForRun: async () => [{ status: "answered", prompt: "Pick one", requestedAtMs: 1, responseJson: '"yes"' }],
      listMemoryFactsForRun: async () => [{ namespace: "run", key: "enabled", valueJson: "true", updatedAtMs: 2 }],
    });
    const result = await listRunDecisionsRoute(params({ resolveRun: async () => ({ workflow: {}, adapter: a }) }));
    expect(result.entries.find((entry: any) => entry.kind === "ask-human")?.resolution.value).toBe("yes");
    expect(result.entries.find((entry: any) => entry.kind === "memory")?.detail.value).toBe(true);
  });
});

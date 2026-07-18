import { describe, expect, test } from "bun:test";
import { decisionEntriesOf, decisionTone, formatDecisionResolution, pendingDecisionCount, sortDecisions, summarizeDecisionValue } from "../src/monitor-ui/monitorDecisionsModel.ts";

describe("decisions model", () => {
  test("reads tolerant gateway rows and sorts missing dates last", () => {
    const entries = decisionEntriesOf({ entries: [{ kind: "approval", node_id: "n", occurred_at_ms: 2, title: "x", status: "pending", resolution: "{}", detail: "{}" }, { kind: "memory", title: "m", status: "recorded" }] });
    expect(sortDecisions(entries).map(x => x.title)).toEqual(["x", "m"]); expect(pendingDecisionCount(entries)).toBe(1);
  });
  test("reads REST envelopes and preserves primitive memory values", () => {
    const entries = decisionEntriesOf({ ok: true, data: { entries: [{ kind: "memory", title: "fact", status: "recorded", detail: "true" }] } });
    expect(entries).toHaveLength(1);
    expect(summarizeDecisionValue("true")).toBe("true");
    expect(summarizeDecisionValue('"hello"')).toBe("hello");
  });
  test("formats resolutions and values", () => {
    expect(decisionTone("auto-approved")).toBe("ok");
    expect(formatDecisionResolution({ kind: "approval", nodeId: null, iteration: null, occurredAtMs: 0, title: "x", status: "denied", resolution: { by: "a", note: "no" }, detail: {} })).toBe("denied by a — no");
    expect(formatDecisionResolution({ kind: "memory", nodeId: null, iteration: null, occurredAtMs: 1, title: "fact", status: "recorded", resolution: null, detail: {} }, 60_001)).toBe("recorded · 1m ago");
    expect(summarizeDecisionValue("plain")).toBe("plain");
  });
  test("shows the resolving payload in the visible line, not only under Details", () => {
    expect(formatDecisionResolution({ kind: "approval", nodeId: null, iteration: null, occurredAtMs: 10, title: "x", status: "approved", resolution: { by: "will", note: "ship it", atMs: 70_010, value: { choice: "prod" } }, detail: {} }))
      .toBe('approved by will — ship it · {"choice":"prod"} · 1m after request');
    expect(formatDecisionResolution({ kind: "ask-human", nodeId: null, iteration: null, occurredAtMs: 5, title: "q", status: "answered", resolution: { by: "cli", value: "yes, canary first" }, detail: {} }))
      .toBe("answered by cli — yes, canary first");
    expect(formatDecisionResolution({ kind: "approval", nodeId: null, iteration: null, occurredAtMs: 5, title: "x", status: "denied", resolution: { by: "a", value: { selected: "later" } }, detail: {} }))
      .toBe('denied by a · {"selected":"later"}');
  });
});

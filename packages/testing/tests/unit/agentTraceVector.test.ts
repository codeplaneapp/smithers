import { describe, expect, test } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  flattenGeneratePrompt,
  loadAgentTraceVector,
  parseAgentTraceVector,
  selectTurn,
} from "../../src/agentTraceVector.ts";
import { createVirtualClock } from "../../src/virtualClock.ts";
import { scriptedAgent } from "../../src/scriptedAgent.ts";
import { expectSoftPinBoard } from "../../src/scenarioAssert.ts";
import { z } from "zod";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/agent-traces");

describe("parseAgentTraceVector", () => {
  test("accepts valid vector", () => {
    const v = parseAgentTraceVector({
      version: 1,
      id: "x",
      turns: [{ result: { kind: "ok", output: { a: 1 } } }],
    });
    expect(v.id).toBe("x");
    expect(v.turns).toHaveLength(1);
  });

  test("rejects bad version", () => {
    expect(() => parseAgentTraceVector({ version: 2, id: "x", turns: [{ result: { kind: "ok" } }] })).toThrow(
      /version must be 1/,
    );
  });
});

describe("loadAgentTraceVector fixtures", () => {
  test("loads JSON pipeline implement", () => {
    const v = loadAgentTraceVector(join(fixtures, "pipeline-implement.v1.json"));
    expect(v.id).toBe("pipeline-implement");
    expect(v.turns[0]?.result.kind).toBe("ok");
  });
});

describe("selectTurn + promptIncludes", () => {
  test("prefers when.promptIncludes match", () => {
    const v = loadAgentTraceVector(join(fixtures, "steer-consumer.v1.json"));
    const used = new Set<number>();
    const hit = selectTurn(v, used, {
      callIndex: 0,
      promptText: "user says FOCUS_EDGE_CASES please",
    });
    expect(hit.index).toBe(0);
    used.add(hit.index);
    const miss = selectTurn(v, used, { callIndex: 1, promptText: "nothing special" });
    expect(miss.index).toBe(1);
  });
});

describe("virtualClock", () => {
  test("advances without wall wait", async () => {
    const c = createVirtualClock({ startMs: 1000 });
    expect(c.now()).toBe(1000);
    const t0 = Date.now();
    await c.advance(30_000);
    expect(c.now()).toBe(31_000);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe("scriptedAgent", () => {
  test("plays stream text via onStdout and returns ok output", async () => {
    const v = loadAgentTraceVector(join(fixtures, "pipeline-implement.v1.json"));
    const clock = createVirtualClock();
    const agent = scriptedAgent(v, {
      clock,
      schema: z.object({ summary: z.string(), ok: z.boolean() }),
    });
    const chunks: string[] = [];
    const result = await agent.generate({
      prompt: "go",
      onStdout: (t) => chunks.push(t),
    });
    expect(result.output).toEqual({ summary: "implemented feature X", ok: true });
    expect(chunks.join("")).toContain("implementing");
    expect(clock.now()).toBeGreaterThanOrEqual(5);
    expect(agent.calls).toHaveLength(1);
  });

  test("fail result throws", async () => {
    const v = loadAgentTraceVector(join(fixtures, "worker-fail.v1.json"));
    const agent = scriptedAgent(v);
    await expect(agent.generate({ prompt: "x" })).rejects.toThrow(/auth tests/);
  });

  test("sequence exhaustion", async () => {
    const v = parseAgentTraceVector({
      version: 1,
      id: "one",
      turns: [{ result: { kind: "ok", output: {} } }],
    });
    const agent = scriptedAgent(v);
    await agent.generate();
    await expect(agent.generate()).rejects.toThrow(/no matching unused turn|exhausted/);
  });
});

describe("expectSoftPinBoard", () => {
  test("allows one stage and promoted worker", () => {
    expect(() =>
      expectSoftPinBoard(["implement", "worker-07"], {
        maxStages: 1,
        mustInclude: ["implement", "worker-07"],
      }),
    ).not.toThrow();
  });

  test("rejects extra workers", () => {
    expect(() => expectSoftPinBoard(["implement", "worker-01", "worker-02"], { maxStages: 1 })).toThrow(/board-only/);
  });
});

describe("flattenGeneratePrompt", () => {
  test("reads messages array", () => {
    expect(
      flattenGeneratePrompt({
        messages: [{ role: "user", content: "FOCUS_EDGE_CASES" }],
      }),
    ).toContain("FOCUS_EDGE_CASES");
  });
});

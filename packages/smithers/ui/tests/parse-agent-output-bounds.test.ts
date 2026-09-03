import { describe, expect, it } from "bun:test";
import { parseAgentOutput } from "../src/agentic/parseAgentOutput";

/**
 * `parseAgentOutput` is the last line before an agent node renders raw provider
 * output. Provider payloads are arbitrary and can be cyclic (an in-process
 * harness that hands over a live object graph) or absurdly deep (a streaming
 * accumulator that nested one wrapper per delta). Neither may reach the React
 * tree as a `RangeError`: the documented degradation is "return what could be
 * read, or null", never "unmount the surface".
 */
describe("parseAgentOutput traversal bounds", () => {
  it("returns rather than overflowing on a self-referential reasoning summary", () => {
    const part: Record<string, unknown> = { type: "reasoning" };
    part.summary = [part];
    expect(() => parseAgentOutput({ reasoning: [part] })).not.toThrow();
  });

  it("returns rather than overflowing on a deep acyclic reasoning summary chain", () => {
    let part: Record<string, unknown> = { type: "summary_text", text: "leaf" };
    for (let i = 0; i < 100_000; i += 1) part = { type: "reasoning", summary: [part] };
    expect(() => parseAgentOutput({ reasoning: [part] })).not.toThrow();
  });

  it("returns rather than overflowing on a deep nested output chain", () => {
    let nested: Record<string, unknown> = { text: "done" };
    for (let i = 0; i < 100_000; i += 1) nested = { output: nested };
    expect(() => parseAgentOutput(nested)).not.toThrow();
  });

  it("still reads a summary nested within the documented depth budget", () => {
    let part: Record<string, unknown> = { type: "summary_text", text: "the plan" };
    for (let i = 0; i < 4; i += 1) part = { type: "reasoning", summary: [part] };
    expect(parseAgentOutput({ reasoning: [part] })?.reasoningSummary).toBe("the plan");
  });

  it("still reads a response nested within the documented output-spine budget", () => {
    let nested: Record<string, unknown> = { text: "hello" };
    for (let i = 0; i < 8; i += 1) nested = { output: nested };
    expect(parseAgentOutput(nested)?.response).toBe("hello");
  });

  it("drops a summary that recurses past the depth budget instead of throwing", () => {
    let part: Record<string, unknown> = { type: "summary_text", text: "too deep" };
    for (let i = 0; i < 200; i += 1) part = { type: "reasoning", summary: [part] };
    expect(parseAgentOutput({ reasoning: [part] })).toBeNull();
  });

  it("stops descending the output spine past the depth budget instead of throwing", () => {
    let nested: Record<string, unknown> = { text: "too deep" };
    for (let i = 0; i < 200; i += 1) nested = { output: nested };
    expect(parseAgentOutput(nested)).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { parseAgentOutput } from "../src/agentic/parseAgentOutput";

const redactedMarkers = [
  { type: "redacted_thinking" },
  { kind: "REDACTED_THINKING" },
  { signature: "signed-metadata" },
  { redactedData: "redacted-metadata" },
  { redacted_data: "redacted-metadata" },
];
const privateMarkers = [
  { type: "reasoning" },
  { type: "thinking" },
  { type: "thought" },
  { kind: "REASONING" },
  { type: "text", kind: "thinking" },
  ...redactedMarkers,
];
const envelopes = ["output", "result", "data", "response", "message"];
const privateText = "PRIVATE_REASONING_SENTINEL";

describe("parseAgentOutput record privacy", () => {
  for (const marker of privateMarkers) {
    test(`filters direct fields at every record position: ${JSON.stringify(marker)}`, () => {
      for (const field of ["text", "markdown", "response", "message", "output", "content", "parts"]) {
        const record = { ...marker, [field]: privateText };
        expect(parseAgentOutput(record)).toBeNull();
        expect(parseAgentOutput({ content: [record] })).toBeNull();
        for (const envelope of envelopes) {
          expect(parseAgentOutput({ [envelope]: record })).toBeNull();
        }
      }
    });

    test(`does not traverse private records: ${JSON.stringify(marker)}`, () => {
      for (const envelope of envelopes) {
        const record = { ...marker, [envelope]: { text: privateText } };
        expect(parseAgentOutput(record)).toBeNull();
        expect(parseAgentOutput({ message: record })).toBeNull();
      }
      const record = {
        ...marker,
        content: [
          { type: "text", text: privateText },
          { type: "summary_text", text: privateText },
          { type: "tool-call", name: "hidden_tool", input: privateText },
        ],
      };
      expect(parseAgentOutput(record)).toBeNull();
      expect(parseAgentOutput({ message: record })).toBeNull();
      expect(parseAgentOutput({ text: "Public answer", message: record })).toEqual({
        response: "Public answer", toolCalls: [], streaming: false,
      });
    });
  }

  test("retains only explicitly disclosed summaries on reasoning records", () => {
    for (const summary of [
      { type: "reasoning", summary: [{ type: "summary_text", text: "Public summary" }] },
      { type: "thinking", reasoningSummary: "Public summary" },
      { type: "thought", reasoning_summary: "Public summary" },
      { type: "summary_text", text: "Public summary" },
      { type: "summary", text: "Public summary" },
      { type: "reasoning_summary", text: "Public summary" },
    ]) {
      const record = { markdown: privateText, output: { text: privateText }, ...summary };
      const expected = { reasoningSummary: "Public summary", toolCalls: [], streaming: false };
      expect(parseAgentOutput(record)).toEqual(expected);
      for (const envelope of envelopes) {
        expect(parseAgentOutput({ [envelope]: record })).toEqual(expected);
      }
      for (const marker of redactedMarkers) {
        expect(parseAgentOutput({ ...record, ...marker })).toBeNull();
      }
    }
  });

  test("keeps public sibling output and streaming while discarding a private envelope", () => {
    expect(parseAgentOutput({
      streaming: true,
      output: { type: "reasoning", text: privateText },
      result: { message: { type: "assistant", content: [{ type: "text", text: "Public answer" }] } },
    })).toEqual({ response: "Public answer", toolCalls: [], streaming: true });
  });
});

describe("parseAgentOutput null and partial contract", () => {
  test("discards over-depth branches without retaining raw JSON in a partial model", () => {
    let output: Record<string, unknown> = { text: "UNREADABLE_BRANCH" };
    for (let i = 0; i < 20; i += 1) output = { output };
    expect(parseAgentOutput(output)).toBeNull();
    expect(parseAgentOutput({ text: "Public answer", output })).toEqual({
      response: "Public answer", toolCalls: [], streaming: false,
    });
  });

  test("discards over-depth summaries while retaining readable summaries", () => {
    let part: Record<string, unknown> = { type: "summary_text", text: "UNREADABLE_BRANCH" };
    for (let i = 0; i < 20; i += 1) part = { type: "reasoning", summary: [part] };
    expect(parseAgentOutput({ reasoning: [part] })).toBeNull();
    expect(parseAgentOutput({ reasoning: [part, { type: "summary_text", text: "Public summary" }] })).toEqual({
      reasoningSummary: "Public summary", toolCalls: [], streaming: false,
    });
  });
});

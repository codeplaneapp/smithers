/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { extractGraph } from "../src/extract.js";
import { extractFromHost } from "../src/dom/extract.js";

function hostEl(tag, rawProps = {}, children = []) {
  return { kind: "element", tag, props: rawProps, rawProps, children };
}

const extractors = [extractGraph, extractFromHost];

describe("numeric graph props", () => {
  test.each(extractors)("coerces retries consistently", (extract) => {
    const zero = extract(hostEl("smithers:task", { id: "zero", output: "out", retries: "0" })).tasks[0];
    expect(zero.retries).toBe(0);
    expect(zero.retryPolicy).toBeUndefined();

    const positive = extract(
      hostEl("smithers:task", {
        id: "positive",
        output: "out",
        retries: "2",
        continueOnFail: true,
      }),
    ).tasks[0];
    expect(positive.retries).toBe(2);
    expect(positive.retryPolicy).toBeDefined();

    const negative = extract(hostEl("smithers:task", { id: "negative", output: "out", retries: "-2" })).tasks[0];
    expect(negative.retries).toBe(0);
  });

  test.each(extractors)("rejects non-finite HumanTask retries", (extract) => {
    for (const value of ["Infinity", "NaN"]) {
      expect(() =>
        extract(
          hostEl("smithers:task", {
            id: "human",
            output: "out",
            __smithersKind: "human",
            retries: value,
          }),
        ),
      ).toThrow('<HumanTask id="human"> maxAttempts must be finite.');
    }
  });

  test.each(extractors)("falls back for invalid ordinary-task retries", (extract) => {
    const task = extract(
      hostEl("smithers:task", {
        id: "invalid-retries",
        output: "out",
        retries: "not-a-number",
      }),
    ).tasks[0];
    expect(task.retries).toBe(Infinity);
  });

  test.each(extractors)("coerces timeoutMs on every descriptor type", (extract) => {
    for (const [tag, props] of [
      ["smithers:task", { id: "task", output: "out" }],
      ["smithers:subflow", { id: "subflow", output: "out" }],
      ["smithers:sandbox", { id: "sandbox", output: "out" }],
      ["smithers:wait-for-event", { id: "wait", output: "out" }],
    ]) {
      expect(extract(hostEl(tag, { ...props, timeoutMs: "123.5" })).tasks[0].timeoutMs).toBe(123.5);
    }
    for (const value of ["", "not-a-number", "NaN", "Infinity"]) {
      expect(
        extract(hostEl("smithers:task", { id: value || "invalid", output: "out", timeoutMs: value })).tasks[0]
          .timeoutMs,
      ).toBeNull();
    }
  });

  test.each(extractors)("floors positive heartbeat aliases and rejects invalid values", (extract) => {
    expect(
      extract(hostEl("smithers:task", { id: "primary", output: "out", heartbeatTimeoutMs: "123.9" })).tasks[0]
        .heartbeatTimeoutMs,
    ).toBe(123);
    expect(
      extract(hostEl("smithers:task", { id: "legacy", output: "out", heartbeatTimeout: "456.9" })).tasks[0]
        .heartbeatTimeoutMs,
    ).toBe(456);
    expect(
      extract(
        hostEl("smithers:task", {
          id: "primary-wins",
          output: "out",
          heartbeatTimeoutMs: "NaN",
          heartbeatTimeout: "456.9",
        }),
      ).tasks[0].heartbeatTimeoutMs,
    ).toBeNull();
    for (const value of ["0", "-1", "NaN", "Infinity"]) {
      expect(
        extract(hostEl("smithers:task", { id: value, output: "out", heartbeatTimeoutMs: value })).tasks[0]
          .heartbeatTimeoutMs,
      ).toBeNull();
    }
  });
});

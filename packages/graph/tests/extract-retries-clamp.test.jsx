/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { extractGraph } from "../src/extract.js";
import { extractFromHost } from "../src/dom/extract.js";

/**
 * @param {string} tag
 * @param {Record<string, any>} [rawProps]
 * @param {any[]} [children]
 */
function hostEl(tag, rawProps = {}, children = []) {
  const stringProps = {};
  for (const [k, v] of Object.entries(rawProps)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      stringProps[k] = String(v);
    }
  }
  return { kind: "element", tag, props: stringProps, rawProps, children };
}

describe("explicit negative retries clamp to 0", () => {
  test("extractGraph clamps retries={-1} to 0 with no retry policy", () => {
    const task = extractGraph(hostEl("smithers:task", { id: "t1", output: "t", retries: -1 })).tasks[0];
    // Regression: an unclamped -1 produced maxAttempts <= 0 downstream —
    // a task that failed without ever executing.
    expect(task.retries).toBe(0);
    expect(task.retryPolicy).toBeUndefined();
  });

  test("extractGraph keeps explicit retries={0} at 0", () => {
    const task = extractGraph(hostEl("smithers:task", { id: "t1", output: "t", retries: 0 })).tasks[0];
    expect(task.retries).toBe(0);
  });
});

describe("dom extraction mirrors the clamp", () => {
  test("extractFromHost clamps retries={-5} to 0", () => {
    const task = extractFromHost(hostEl("smithers:task", { id: "t1", output: "t", retries: -5 })).tasks[0];
    expect(task.retries).toBe(0);
    expect(task.retryPolicy).toBeUndefined();
  });
});

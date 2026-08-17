import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createExternalSmithersEngine } from "../src/index.js";

const EXAMPLE = fileURLToPath(new URL("../../../examples/node-embedded-engine.mjs", import.meta.url));

describe("createExternalSmithersEngine", () => {
  test("is exported from the public facade", () => {
    expect(typeof createExternalSmithersEngine).toBe("function");
  });

  test("constructs under plain Node, routes logs, reuses one instance, and preserves causes", () => {
    const node = Bun.which("node");
    if (!node) return;
    const child = spawnSync(node, [EXAMPLE], { encoding: "utf8", timeout: 180_000 });
    expect(child.status, `${child.stderr}\n${child.stdout}`).toBe(0);
    const report = JSON.parse(child.stdout.trim());
    expect(report.status).toBe("ok");
    expect(report.runs).toHaveLength(2);
    expect(new Set(report.runs).size).toBe(2);
    expect(report.logRecords).toBeGreaterThan(0);
    expect(report.causeChain.join(" ")).toContain("provider request failed");
    expect(report.causeChain.join(" ")).toContain("connection refused");
  }, 190_000);
});

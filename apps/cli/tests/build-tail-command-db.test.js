import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { buildTailCommand } from "../src/herdr.js";

const realCliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

describe("buildTailCommand --db pin", () => {
  test("includes --db when dbPath provided (detail tab store pin)", () => {
    const argv = buildTailCommand(realCliPath, {
      dbPath: "/home/jm/orch/smithers.db",
    })({ runId: "run-1", nodeId: "q3" });
    expect(argv).toContain("--db");
    const i = argv.indexOf("--db");
    expect(argv[i + 1]).toBe("/home/jm/orch/smithers.db");
    expect(argv).toContain("run-1");
    expect(argv).toContain("q3");
    // Thin entry path (not full index.js tail)
    expect(argv.some((a) => String(a).includes("node-detail-entry"))).toBe(true);
  });
});

/**
 * Unit tests for the post-run narrator/report module. The narrator itself needs
 * a live agent, so these cover the pure parser plus the deterministic fallback
 * that must always produce and open an HTML report even with no agent available.
 */
import { describe, expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateRunReport, parseNarratorResponse } from "../src/runReport.js";

describe("parseNarratorResponse", () => {
  test("splits the terminal and HTML sections on their sentinels", () => {
    const raw = [
      "===SMITHERS_TERMINAL===",
      "All good. The run finished.",
      "- greeted the world",
      "===SMITHERS_HTML===",
      "<!doctype html><html><body>hi</body></html>",
    ].join("\n");
    const { terminal, html } = parseNarratorResponse(raw);
    expect(terminal).toContain("All good");
    expect(terminal).not.toContain("SMITHERS");
    expect(html).toStartWith("<!doctype html>");
  });

  test("recovers HTML wrapped in a code fence", () => {
    const raw = "===SMITHERS_TERMINAL===\nok\n===SMITHERS_HTML===\n```html\n<!doctype html><html></html>\n```";
    const { html } = parseNarratorResponse(raw);
    expect(html).toStartWith("<!doctype html>");
    expect(html).not.toContain("```");
  });

  test("returns null html when the response has no document", () => {
    const { terminal, html } = parseNarratorResponse("just some prose, no report");
    expect(terminal).toBe("just some prose, no report");
    expect(html).toBeNull();
  });
});

describe("generateRunReport fallback (no agent)", () => {
  function fakeAdapter() {
    return {
      getRun: async () => ({ startedAtMs: 1000, finishedAtMs: 3500, workflowName: "hello" }),
      listEvents: async () => [
        { type: "NodeOutput", seq: 1, payloadJson: JSON.stringify({ nodeId: "greet", text: "Hello, world!" }) },
      ],
    };
  }

  test("writes a deterministic HTML report and opens it when no agent is usable", async () => {
    const packDir = mkdtempSync(join(tmpdir(), "smithers-report-"));
    onTestFinished(() => rmSync(packDir, { recursive: true, force: true }));
    let opened;
    const result = await generateRunReport({
      adapter: fakeAdapter(),
      runId: "run-abc/1",
      workflowName: "hello",
      result: { status: "finished", output: { greeting: "Hello, world!" } },
      cwd: packDir,
      packDir,
      // No usable agent: empty PATH + isolated HOME so detection finds none.
      env: { PATH: "", HOME: packDir },
      open: (target) => {
        opened = target;
        return true;
      },
    });
    expect(result).not.toBeNull();
    expect(result.agentId).toBeNull();
    expect(result.opened).toBe(true);
    // runId path separators are sanitized into the filename.
    expect(result.reportPath).toContain("run-abc_1.html");
    expect(existsSync(result.reportPath)).toBe(true);
    const html = readFileSync(result.reportPath, "utf8");
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("hello");
    expect(html).toContain("finished");
    expect(opened).toBe(result.reportPath);
  });

  test("never throws on a broken adapter — returns a report or null", async () => {
    const packDir = mkdtempSync(join(tmpdir(), "smithers-report-"));
    onTestFinished(() => rmSync(packDir, { recursive: true, force: true }));
    const result = await generateRunReport({
      adapter: {
        getRun: async () => {
          throw new Error("db gone");
        },
        listEvents: async () => {
          throw new Error("db gone");
        },
      },
      runId: "run-x",
      workflowName: "hello",
      result: { status: "finished" },
      cwd: packDir,
      packDir,
      env: { PATH: "", HOME: packDir },
      open: () => true,
    });
    // A broken adapter still yields a fallback report (facts come from result).
    expect(result).not.toBeNull();
    expect(existsSync(result.reportPath)).toBe(true);
  });
});

import { describe, expect, it } from "bun:test";
import { benchmarkHarnessCommand } from "./benchmarkHarnessCommand";
import { buildReviewPanel } from "./buildReviewPanel";

describe("buildReviewPanel", () => {
  it("is a panel of Codex + Opus (review only)", () => {
    const panel = buildReviewPanel();
    expect(panel).toHaveLength(2);
    expect(panel[0].constructor.name).toBe("CodexAgent");
    expect(panel[1].constructor.name).toBe("ClaudeCodeAgent");
  });

  it("adds a third Sonnet reviewer on request", () => {
    const panel = buildReviewPanel({ includeSonnet: true });
    expect(panel).toHaveLength(3);
    expect(panel[2].constructor.name).toBe("ClaudeCodeAgent");
  });
});

describe("benchmarkHarnessCommand", () => {
  it("implements swe-bench-pro with Claude, never Codex/GPT", () => {
    const cmd = benchmarkHarnessCommand("swe-bench-pro", ["a", "b"]);
    const impl = cmd.args[cmd.args.indexOf("--implementer") + 1];
    expect(impl.startsWith("claude")).toBe(true);
    expect(impl).not.toContain("gpt");
    expect(cmd.args).toContain("--gateway");
    expect(cmd.args[cmd.args.indexOf("--ids") + 1]).toBe("a,b");
  });

  it("keeps Codex as the reviewer only", () => {
    const cmd = benchmarkHarnessCommand("swe-bench-pro", ["a"]);
    expect(cmd.args[cmd.args.indexOf("--reviewer") + 1]).toBe("gpt-5.5");
  });

  it("runs swe-evo and roadmapbench with Claude implementation via env", () => {
    const evo = benchmarkHarnessCommand("swe-evo", ["iterative__dvc_1"]);
    expect(evo.env.SWEEVO_CLAUDE_MODEL.startsWith("claude")).toBe(true);
    const rmb = benchmarkHarnessCommand("roadmapbench", ["opt-4.5.0-roadmap"]);
    expect(rmb.args).toContain("benchmarks/roadmapbench/harness/launch_benchmark.sh");
    expect(rmb.env.ROADMAPBENCH_REVIEW_MODEL).toBeTruthy();
  });

  it("honors an explicit Claude implementer override", () => {
    const cmd = benchmarkHarnessCommand("swe-bench-pro", ["a"], { implementer: "claude-opus-4-8" });
    expect(cmd.args[cmd.args.indexOf("--implementer") + 1]).toBe("claude-opus-4-8");
  });

  it("throws on an unknown benchmark", () => {
    expect(() => benchmarkHarnessCommand("nope", ["a"])).toThrow();
  });
});

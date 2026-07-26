import { describe, expect, test } from "bun:test";
import { parseAgentWiringArgv } from "../src/agent-wiring/parseAgentWiringArgv.js";
import { reportReplayResult } from "../src/reportReplayResult.js";
import { prettyValue } from "../src/pretty.js";
import { assertCliArgumentBounds, wrapCliCommandHandlersWithInputBounds } from "../src/cli-command-bounds.js";
import { buildStarterGallery, renderStarterGallery } from "../src/starter-gallery.js";

describe("parseAgentWiringArgv --global", () => {
  test("explicit --global keeps global true", () => {
    const result = parseAgentWiringArgv(["mcp", "add", "--no-global", "--global"]);
    expect(result).toMatchObject({ kind: "mcp", global: true });
  });
});

describe("reportReplayResult vcsRestored branch", () => {
  test("prints the restored-pointer line when VCS state was restored", () => {
    let out = "";
    reportReplayResult({
      result: { runId: "child", vcsRestored: true, vcsPointer: "tag/xyz" },
      parentRunId: "parent",
      parentFrame: 3,
      stderr: {
        write: (s) => {
          out += s;
        },
      },
    });
    expect(out).toContain("Forked run child from parent:3");
    expect(out).toContain("VCS state restored to tag/xyz");
  });

  test("prints no VCS line when neither restored nor errored", () => {
    let out = "";
    reportReplayResult({
      result: { runId: "child" },
      parentRunId: "parent",
      parentFrame: 0,
      stderr: {
        write: (s) => {
          out += s;
        },
      },
    });
    expect(out).toBe("[smithers] Forked run child from parent:0\n");
  });
});

describe("prettyValue Date scalar", () => {
  test("renders a top-level Date via its ISO string", () => {
    const out = prettyValue(new Date(0));
    expect(out).toContain("1970-01-01T00:00:00.000Z");
  });

  test("renders a Date nested under a key", () => {
    const out = prettyValue({ when: new Date(0) });
    expect(out).toContain("1970-01-01T00:00:00.000Z");
  });
});

describe("assertCliArgumentBounds array + non-string leaves", () => {
  test("recurses into array elements with indexed paths", () => {
    // Each element is validated by its own path; oversize entries throw.
    expect(() => assertCliArgumentBounds(["ok", "also-ok"], "args")).not.toThrow();
    const huge = "x".repeat(5000);
    expect(() => assertCliArgumentBounds([huge], "args")).toThrow();
  });

  test("ignores non-string, non-array, non-object leaves", () => {
    expect(() => assertCliArgumentBounds(42, "args")).not.toThrow();
    expect(() => assertCliArgumentBounds(true, "args")).not.toThrow();
    expect(() => assertCliArgumentBounds(null, "args")).not.toThrow();
    expect(() => assertCliArgumentBounds(undefined, "args")).not.toThrow();
  });

  test("recurses into object entries", () => {
    expect(() => assertCliArgumentBounds({ runId: "r", nested: { name: "n" } }, "args")).not.toThrow();
  });
});

describe("wrapCliCommandHandlersWithInputBounds branches", () => {
  test("skips null/non-object entries, groups, fetch, already-wrapped, and non-function run", () => {
    let ran = null;
    const runHandler = (ctx) => {
      ran = ctx;
      return "done";
    };
    const groupInner = new Map([["leaf", { run: runHandler }]]);
    const commands = new Map([
      ["null-entry", null],
      ["string-entry", "not-an-object"],
      ["group", { _group: true, commands: groupInner }],
      ["fetch", { _fetch: () => {} }],
      ["no-run", { notRun: 1 }],
      ["cmd", { run: runHandler }],
    ]);
    wrapCliCommandHandlersWithInputBounds(commands);
    // The wrapped handler validates args/options then delegates.
    const wrapped = commands.get("cmd");
    expect(typeof wrapped.run).toBe("function");
    expect(wrapped.run({ args: { runId: "r" }, options: {} })).toBe("done");
    expect(ran).toEqual({ args: { runId: "r" }, options: {} });
    // The nested group's leaf handler is wrapped too.
    expect(groupInner.get("leaf").run({ args: {}, options: {} })).toBe("done");

    // Idempotent: a second pass is a no-op (already-wrapped skip).
    const wrappedRun = wrapped.run;
    wrapCliCommandHandlersWithInputBounds(commands);
    expect(commands.get("cmd").run).toBe(wrappedRun);
  });

  test("rejects oversized args through the wrapped handler", () => {
    const commands = new Map([["cmd", { run: () => "ok" }]]);
    wrapCliCommandHandlersWithInputBounds(commands);
    const huge = "x".repeat(300_000);
    expect(() => commands.get("cmd").run({ args: { prompt: huge }, options: {} })).toThrow();
  });
});

describe("renderStarterGallery empty result", () => {
  test("renders the no-matches guidance when filters exclude every starter", () => {
    const gallery = buildStarterGallery({ audience: "no-such-audience" });
    expect(gallery.count).toBe(0);
    const text = renderStarterGallery(gallery);
    expect(text).toContain("No starters matched those filters.");
    expect(text).toContain("starters --audience product");
  });
});

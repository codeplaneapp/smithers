import { describe, expect, test } from "bun:test";
import {
  assetBaseFromUrl,
  buildChatLines,
  chatLineFromFrame,
  chatLinesFromFrame,
  logLineFromFrame,
  makeAssetUrl,
  resolveDocLink,
  rowOf,
  type EventFrame,
} from "../ui/ddd-shared.tsx";
import {
  extractMaterializedTickets,
  extractTriage,
  ticketsFromTriage,
  toRunRows,
} from "../ui/docs-driven-development.tsx";

function frame(seq: number, event: string, payload: Record<string, unknown>): EventFrame {
  return { seq, payload: { event, payload } };
}

describe("DDD UI parser contracts", () => {
  test("rowOf, toRunRows, extractTriage, and extractMaterializedTickets accept gateway row shapes and snake_case fallbacks", () => {
    expect(rowOf({ row: { a: 1 } })).toEqual({ a: 1 });
    expect(rowOf({ data: { row: { b: 2 } } })).toEqual({ b: 2 });
    expect(rowOf({ data: { c: 3 } })).toEqual({ c: 3 });
    expect(rowOf(null)).toBeNull();

    expect(toRunRows([{ id: "r1", status: "finished" }, { runId: "r2", workflowKey: "ddd" }, { status: "bad" }]))
      .toEqual([{ id: "r1", runId: "r1", status: "finished" }, { runId: "r2", workflowKey: "ddd" }]);
    expect(toRunRows({ runs: [{ id: "r3" }] })).toEqual([{ id: "r3", runId: "r3" }]);

    const triage = extractTriage({
      data: {
        row: {
          selected: JSON.stringify([
            {
              slot: 1,
              feature_id: "cli",
              title: "CLI proof",
              agent: "sonnet",
              task_type: "e2e",
              reason: "Missing e2e.",
              files: [".smithers/ui/docs-driven-development.tsx"],
              tests: ["bun test"],
              acceptance: ["proof"],
            },
            { slot: 0, featureId: "ignored" },
          ]),
        },
      },
    });
    expect(triage).toEqual([
      {
        slot: 1,
        featureId: "cli",
        title: "CLI proof",
        agent: "sonnet",
        reason: "Missing e2e.",
        taskType: "e2e",
        files: [".smithers/ui/docs-driven-development.tsx"],
        tests: ["bun test"],
        acceptance: ["proof"],
      },
    ]);

    const materialized = extractMaterializedTickets({
      row: {
        tickets: [
          { path: "tickets/one", kind: "", status: "", content: "# One", updated_at_ms: 42 },
          { path: "", content: "ignored" },
        ],
      },
    });
    expect(materialized).toEqual([
      { path: "tickets/one", kind: "ticket", status: "todo", content: "# One", updated_at_ms: 42, updatedAtMs: 42 },
    ]);

    expect(ticketsFromTriage("run 1", triage)[0]?.content).toContain("Task type: e2e");
  });

  test("chatLineFromFrame handles public dotted events, top-level event frames, and legacy engine events", () => {
    expect(chatLineFromFrame(frame(1, "task.output", { nodeId: "bootstrap", output: "built" }))).toEqual({
      who: "bootstrap",
      text: "built",
    });
    expect(chatLineFromFrame({ seq: 2, event: "task.output", payload: { nodeId: "triage", output: "planned" } })).toEqual({
      who: "triage",
      text: "planned",
    });
    expect(chatLineFromFrame(frame(3, "agent.trace", { nodeId: "audit", trace: { payload: { text: "trace text" } } }))).toEqual({
      who: "audit",
      text: "trace text",
    });
    expect(chatLineFromFrame(frame(4, "AgentEvent", { engine: "codex", event: { message: "legacy message" } }))).toEqual({
      who: "codex",
      text: "legacy message",
    });
    expect(chatLineFromFrame({ seq: 5, payload: null })).toBeNull();
  });

  test("chatLinesFromFrame expands transcripts, summarizes tool use, suppresses tool results, and tolerates malformed payloads", () => {
    const lines = chatLinesFromFrame(frame(1, "agent.session", {
      transcript: [
        { role: "user", content: "Investigate DDD" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading files" },
            { type: "tool_use", name: "shell" },
            { type: "tool_result", text: "very noisy output" },
            { type: "reasoning", text: "Need a parser guard" },
          ],
        },
      ],
    }));

    expect(lines).toEqual([
      { who: "user", role: "user", text: "Investigate DDD", kind: "message" },
      { who: "assistant", role: "assistant", text: "Reading files\n↗ shell\nNeed a parser guard", kind: "message" },
    ]);
    expect(lines.map((line) => line.text).join("\n")).not.toContain("very noisy output");
    expect(chatLinesFromFrame({ seq: 2, payload: { event: "agent.session", payload: { transcript: [null, { content: [] }] } } })).toEqual([]);
    expect(chatLinesFromFrame({ seq: 3, payload: null })).toEqual([]);
  });

  test("buildChatLines dedupes cumulative sessions and completed answers while preserving unique output lines", () => {
    const frames = [
      frame(1, "agent.session", { transcript: [{ role: "user", content: "Please test DDD" }] }),
      frame(2, "agent.session", {
        transcript: [
          { role: "user", content: "Please test DDD" },
          { role: "assistant", content: "Done with parser tests" },
        ],
      }),
      frame(3, "agent.event", { engine: "codex", event: { type: "completed", answer: "Done with parser tests" } }),
      frame(4, "agent.event", {
        engine: "codex",
        event: {
          type: "action",
          entryType: "message",
          action: { kind: "note", detail: { type: "agent_message" } },
          message: "A separate assistant note",
        },
      }),
      frame(5, "task.output", { nodeId: "round-summary", output: "summary output" }),
    ];

    expect(buildChatLines(frames).map((line) => `${line.who}:${line.text}`)).toEqual([
      "user:Please test DDD",
      "assistant:Done with parser tests",
      "codex:A separate assistant note",
      "round-summary:summary output",
    ]);
  });

  test("logLineFromFrame skips heartbeats and truncates detail to 600 characters", () => {
    expect(logLineFromFrame(frame(1, "run.heartbeat", { status: "ok" }))).toBeNull();
    expect(logLineFromFrame(frame(2, "task.heartbeat", { status: "ok" }))).toBeNull();

    const line = logLineFromFrame(frame(3, "agent.event", {
      nodeId: "work:1",
      event: { message: "x".repeat(700) },
    }));
    expect(line?.seq).toBe(3);
    expect(line?.event).toBe("agent.event");
    expect(line?.node).toBe("work:1");
    expect(line?.detail).toHaveLength(600);
  });

  test("resolveDocLink covers external, mailto, anchor, root-relative, relative, and dead links", () => {
    const docs = new Set(["overview.md", "features/cli.md", "reference/api.md"]);
    const hasPath = (path: string) => docs.has(path);

    expect(resolveDocLink("features/cli.md", "https://example.com", hasPath)).toEqual({ kind: "external", href: "https://example.com" });
    expect(resolveDocLink("features/cli.md", "mailto:test@example.com", hasPath)).toEqual({ kind: "external", href: "mailto:test@example.com" });
    expect(resolveDocLink("features/cli.md", "#run", hasPath)).toEqual({ kind: "anchor", anchor: "run" });
    expect(resolveDocLink("features/cli.md", "/overview.md", hasPath)).toEqual({ kind: "doc", path: "overview.md", anchor: "" });
    expect(resolveDocLink("features/cli.md", "../reference/api.md#runs", hasPath)).toEqual({ kind: "doc", path: "reference/api.md", anchor: "runs" });
    expect(resolveDocLink("features/cli.md", "missing.md", hasPath)).toBeNull();
  });

  test("asset base parsing strips trailing slashes and asset URLs preserve passthrough semantics", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { search: "?assetBaseUrl=http://assets.local///" },
    });
    expect(assetBaseFromUrl()).toBe("http://assets.local");

    const url = makeAssetUrl("http://assets.local");
    expect(url("https://cdn.test/x.png")).toBe("https://cdn.test/x.png");
    expect(url("/evidence/proof.png")).toBe("http://assets.local/evidence/proof.png");
    expect(url("/deck-assets/slide.png")).toBe("http://assets.local/deck-assets/slide.png");
    expect(url("relative.png")).toBe("relative.png");
    expect(url(undefined)).toBeUndefined();
  });
});

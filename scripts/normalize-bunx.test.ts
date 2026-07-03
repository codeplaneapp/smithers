import { describe, expect, test } from "bun:test";

import { normalizeCommands, normalizeInline, rewrite } from "./normalize-bunx.ts";

describe("normalize-bunx", () => {
  test("rewrites bare and runner-prefixed Smithers CLI invocations", () => {
    expect(normalizeCommands("smithers run workflow.tsx")).toBe(
      "bunx smithers-orchestrator run workflow.tsx",
    );
    expect(normalizeCommands("bunx smithers up workflow.tsx")).toBe(
      "bunx smithers-orchestrator up workflow.tsx",
    );
    expect(normalizeCommands("npx smithers <command>")).toBe(
      "bunx smithers-orchestrator <command>",
    );
    expect(normalizeCommands("$ smithers inspect RUN_ID")).toBe(
      "$ bunx smithers-orchestrator inspect RUN_ID",
    );
  });

  test("leaves package names, slash commands, and path-prefixed bins intact", () => {
    const commands = [
      "smithers-orchestrator run workflow.tsx",
      "./node_modules/.bin/smithers run workflow.tsx",
      "/usr/local/bin/smithers up",
      String.raw`C:\tools\smithers run workflow.tsx`,
      "@smithersai/smithers run workflow.tsx",
      "my-smithers run workflow.tsx",
      "foo.smithers run workflow.tsx",
      "/smithers run workflow.tsx",
    ];

    for (const command of commands) {
      expect(normalizeCommands(command)).toBe(command);
    }
  });

  test("normalizeInline rewrites CLI code spans but not prose or path-prefixed bins", () => {
    expect(normalizeInline("Run `smithers run workflow.tsx` from the project root.")).toBe(
      "Run `bunx smithers-orchestrator run workflow.tsx` from the project root.",
    );
    expect(normalizeInline("The smithers run command appears in prose.")).toBe(
      "The smithers run command appears in prose.",
    );
    expect(normalizeInline("Use `my-smithers run workflow.tsx` from your fork.")).toBe(
      "Use `my-smithers run workflow.tsx` from your fork.",
    );
  });

  test("normalizes only code spans and shell fences", () => {
    expect(rewrite("Run `smithers run workflow.tsx` from the project root.")).toBe(
      "Run `bunx smithers-orchestrator run workflow.tsx` from the project root.",
    );
    expect(rewrite("The smithers run command appears in prose.")).toBe(
      "The smithers run command appears in prose.",
    );
    expect(rewrite("```bash\nsmithers up workflow.tsx\n```")).toBe(
      "```bash\nbunx smithers-orchestrator up workflow.tsx\n```",
    );
    expect(rewrite("`my-smithers run workflow.tsx`")).toBe("`my-smithers run workflow.tsx`");
  });
});

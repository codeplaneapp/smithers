// Unit coverage for scripts/normalize-placeholders.ts (SCRIPT_NORMALIZE_PLACEHOLDERS,
// run in --check mode by scripts/check-docs.mjs). check-docs only proves the
// committed docs are clean; these tests pin the rewrite rules themselves —
// which contexts get normalized, which are deliberately left alone, and the
// bare-<id> disambiguation — so a regression can't silently rewrite docs wrong.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isPathOrUrlContext,
  mapBareId,
  normalizeCommand,
  normalizeProseLine,
  rewrite,
} from "../../../scripts/normalize-placeholders.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("normalize-placeholders units", () => {
  test("hyphenated tokens are replaced in any command context", () => {
    expect(normalizeCommand("smithers logs <run-id> --node <node-id>")).toBe("smithers logs RUN_ID --node NODE_ID");
    expect(normalizeCommand("smithers workflow run <workflow-id>")).toBe("smithers workflow run WORKFLOW_ID");
  });

  test("camelCase and snake_case id tokens map to their uppercase forms", () => {
    expect(normalizeCommand("smithers inspect <runId>")).toBe("smithers inspect RUN_ID");
    expect(normalizeCommand("smithers inspect <run_id>")).toBe("smithers inspect RUN_ID");
    expect(normalizeCommand("smithers node <nodeId>")).toBe("smithers node NODE_ID");
    expect(normalizeCommand("smithers graph <workflowId>")).toBe("smithers graph WORKFLOW_ID");
  });

  test("path and URL templates keep their angle-bracket placeholders", () => {
    const path = "cat .smithers/executions/<runId>/logs/agent.ndjson";
    expect(isPathOrUrlContext(path)).toBe(true);
    expect(normalizeCommand(path)).toBe(path);
    const url = "curl 'http://localhost:3000/api?runId=<id>'";
    expect(normalizeCommand(url)).toBe(url);
    // The hyphenated wrap-bug tokens are still fixed even in path context.
    expect(normalizeCommand("cat executions/<runId>/x <run-id>")).toBe("cat executions/<runId>/x RUN_ID");
  });

  test("<node> is replaced only as the argument of --node / --node-id", () => {
    expect(normalizeCommand("smithers node --node <node>")).toBe("smithers node --node NODE_ID");
    expect(normalizeCommand("smithers retry --node-id <node>")).toBe("smithers retry --node-id NODE_ID");
    expect(normalizeCommand("echo <node>")).toBe("echo <node>");
  });

  test("bare <id> is disambiguated by the surrounding command", () => {
    expect(mapBareId("smithers create --template <id>")).toBe("TEMPLATE_ID");
    expect(mapBareId("smithers workflow run <id>")).toBe("WORKFLOW_ID");
    expect(mapBareId("smithers workflow inspect <id>")).toBe("WORKFLOW_ID");
    expect(mapBareId("smithers retry --node <id>")).toBe("NODE_ID");
    expect(mapBareId("smithers logs <id>")).toBe("RUN_ID");
    expect(normalizeCommand("smithers workflow run <id>")).toBe("smithers workflow run WORKFLOW_ID");
    expect(normalizeCommand("smithers logs <id>")).toBe("smithers logs RUN_ID");
  });

  test("prose normalizes hyphenated tokens everywhere but command tokens only in smthrs spans", () => {
    expect(normalizeProseLine("Pass the <run-id> to the command.")).toBe("Pass the RUN_ID to the command.");
    expect(normalizeProseLine("Run `bunx smthrs inspect <runId>` to check.")).toBe(
      "Run `bunx smthrs inspect RUN_ID` to check.",
    );
    // Non-smithers spans and prose mentions of <runId> stay untouched.
    expect(normalizeProseLine("Use `other-tool <runId>` instead.")).toBe("Use `other-tool <runId>` instead.");
    expect(normalizeProseLine("The <runId> appears in prose.")).toBe("The <runId> appears in prose.");
    // Path/URL template spans keep their placeholders even for smithers commands.
    expect(normalizeProseLine("See `bunx smthrs logs .smithers/executions/<runId>/`.")).toBe(
      "See `bunx smthrs logs .smithers/executions/<runId>/`.",
    );
  });

  test("rewrite scopes command normalization to shell fences and restores prose rules after the fence", () => {
    const input = [
      "Use <run-id> in prose.",
      "```bash",
      "smithers logs <runId>",
      "cat executions/<runId>/log",
      "```",
      "```ts",
      'const id = "<runId>"; // <run-id>',
      "```",
      "```",
      "smithers inspect <id>",
      "```",
      "After: `bunx smthrs node <nodeId>` and <runId> in prose.",
    ].join("\n");
    const expected = [
      "Use RUN_ID in prose.",
      "```bash",
      "smithers logs RUN_ID",
      "cat executions/<runId>/log",
      "```",
      "```ts",
      // Non-shell fences only get the hyphenated wrap-bug fix.
      'const id = "<runId>"; // RUN_ID',
      "```",
      "```",
      // A bare fence counts as shell.
      "smithers inspect RUN_ID",
      "```",
      "After: `bunx smthrs node NODE_ID` and <runId> in prose.",
    ].join("\n");
    expect(rewrite(input)).toBe(expected);
  });

  test("rewrite is idempotent and handles the empty document", () => {
    expect(rewrite("")).toBe("");
    const doc = "Prose <run-id>\n```bash\nsmithers logs <id>\n```\n";
    expect(rewrite(rewrite(doc))).toBe(rewrite(doc));
  });

  test("the CLI --check entrypoint still runs behind the import.meta.main guard and passes on committed docs", () => {
    const result = spawnSync("bun", ["scripts/normalize-placeholders.ts", "--check"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("no hyphenated angle-bracket CLI placeholders in docs");
  });
});

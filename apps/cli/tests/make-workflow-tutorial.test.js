import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const WORKFLOW_PATH = ".smithers/workflows/make-workflow-tutorial.tsx";

test("make-workflow-tutorial remains a documented archived example", () => {
  const example = resolve(REPO_ROOT, "examples/init-pack/make-workflow-tutorial.tsx");
  expect(readFileSync(example, "utf8")).toContain("Example only:");
  expect(readFileSync(resolve(REPO_ROOT, "examples/init-pack/README.md"), "utf8")).toContain("make-workflow-tutorial");
});

test("make-workflow-tutorial keeps bounded external-session and human-doc readers wired", () => {
  const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
  expect(source).toContain("@smithers-orchestrator/observability/_traceRedaction");
  expect(source).toContain('.codex", "history.jsonl');
  expect(source).toContain("assistant");
  expect(source).toContain("MAX_BYTES_PER_FILE");
  expect(source).toContain('"docs", "guide"');
  expect(source).toContain("You say|You ask your agent");
});

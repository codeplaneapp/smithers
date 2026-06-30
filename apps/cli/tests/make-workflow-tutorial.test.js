import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_SEEDED_FILES } from "../src/seeded-workflow-pack.generated.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const WORKFLOW_PATH = ".smithers/workflows/make-workflow-tutorial.tsx";

test("make-workflow-tutorial ships as a seeded workflow with its prompts", () => {
    const paths = new Set(GENERATED_SEEDED_FILES.map((f) => f.path));
    expect(paths.has(WORKFLOW_PATH)).toBe(true);
    expect(paths.has(".smithers/prompts/make-workflow-tutorial-recommend.mdx")).toBe(true);
    expect(paths.has(".smithers/prompts/make-workflow-tutorial-pick.mdx")).toBe(true);
    expect(paths.has(".smithers/prompts/make-workflow-tutorial-dive-deeper.mdx")).toBe(true);
});

test("make-workflow-tutorial keeps bounded external-session and human-doc readers wired", () => {
    const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
    expect(source).toContain("@smithers-orchestrator/observability/_traceRedaction");
    expect(source).toContain(".codex\", \"history.jsonl");
    expect(source).toContain("assistant");
    expect(source).toContain("MAX_BYTES_PER_FILE");
    expect(source).toContain("\"docs\", \"guide\"");
    expect(source).toContain("You say|You ask your agent");
});

import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutableDir, writeFakeCodexBinary } from "../../../packages/smithers/tests/e2e-helpers.js";
import {
  CURATED_PUBLIC_WORKFLOW_IDS,
  CURATED_SYSTEM_WORKFLOW_IDS,
  UI_WORKFLOW_IDS,
  initWorkflowPack,
} from "../src/workflow-pack.js";
import { discoverWorkflows, resolveWorkflow } from "../src/workflows.js";

function seededAgentEnv() {
  const binDir = createExecutableDir();
  writeFakeCodexBinary(binDir);
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    OPENAI_API_KEY: "sk-test-openai-key",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
}

function freshPack(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "smithers-curated-pack-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const result = initWorkflowPack({
    rootDir: root,
    installSkill: false,
    skipInstall: true,
    env: seededAgentEnv(),
    ...extra,
  });
  return { root, pack: join(root, ".smithers"), result };
}

test("fresh init installs exactly the curated public and hidden system workflows", () => {
  const { pack, result } = freshPack();
  expect(result.writtenFiles.length).toBeGreaterThan(0);
  expect(
    readdirSync(join(pack, "workflows"))
      .filter((file) => file.endsWith(".tsx"))
      .sort(),
  ).toEqual([...CURATED_PUBLIC_WORKFLOW_IDS, ...CURATED_SYSTEM_WORKFLOW_IDS].map((id) => `${id}.tsx`).sort());
  const gateway = readFileSync(join(pack, "gateway.ts"), "utf8");
  const mounted = [...gateway.matchAll(/await mountWorkflow\("([^"]+)"/g)].map((match) => match[1]);
  // Hidden system workflows may still own UIs that are directly addressable.
  expect(mounted).toEqual(UI_WORKFLOW_IDS);
  const installedWorkflowIds = [...CURATED_PUBLIC_WORKFLOW_IDS, ...CURATED_SYSTEM_WORKFLOW_IDS];
  expect(UI_WORKFLOW_IDS.filter((id) => !installedWorkflowIds.includes(id))).toEqual([]);
}, 30_000);

test("the curated contract cannot be narrowed by a removed selectedWorkflows option", () => {
  const { pack } = freshPack({ selectedWorkflows: ["hello"] });
  const workflows = readdirSync(join(pack, "workflows"))
    .filter((file) => file.endsWith(".tsx"))
    .sort();
  expect(workflows).toEqual(
    [...CURATED_PUBLIC_WORKFLOW_IDS, ...CURATED_SYSTEM_WORKFLOW_IDS].map((id) => `${id}.tsx`).sort(),
  );
  expect(workflows).not.toContain("hello.tsx");
}, 30_000);

test("fresh pack includes real UI closures rather than generated render shims", () => {
  const { pack } = freshPack();
  const ui = new Set(readdirSync(join(pack, "ui")));
  for (const entry of ["create-workflow.tsx", "create-skill.tsx", "cw-editor.tsx", "cw-graph.tsx"]) {
    expect(ui.has(entry), entry).toBe(true);
  }
  expect(readFileSync(join(pack, "ui", "create-workflow.tsx"), "utf8")).toContain("useGatewayApprovals");
}, 30_000);

test("add remains runnable while hidden from the default workflow listing", () => {
  const { root } = freshPack();
  const discovered = discoverWorkflows(root);
  expect(discovered.some((workflow) => workflow.id === "add")).toBe(true);
  expect(discovered.filter((workflow) => !workflow.system).some((workflow) => workflow.id === "add")).toBe(false);
  expect(resolveWorkflow("add", root).id).toBe("add");
  expect(resolveWorkflow("add", root).system).toBe(true);
}, 30_000);

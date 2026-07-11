import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createExecutableDir, writeFakeCodexBinary } from "../../../packages/smithers/tests/e2e-helpers.js";
import { buildComponentImporterMap, componentBaseName, importsComponent, workflowId } from "../src/initPackUpdates.js";
import { applyWorkflowPackUpdates, initWorkflowPack } from "../src/workflow-pack.js";

function seededAgentEnv(homeDir) {
  const binDir = createExecutableDir();
  writeFakeCodexBinary(binDir);
  return {
    HOME: homeDir,
    SMITHERS_HOME: join(homeDir, ".smithers-home"),
    PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    OPENAI_API_KEY: "sk-test-openai-key",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
}

test("componentBaseName / workflowId classify pack paths", () => {
  expect(componentBaseName(".smithers/components/Review.tsx")).toBe("Review");
  expect(componentBaseName(".smithers/components/roles.ts")).toBe("roles");
  expect(componentBaseName(".smithers/workflows/implement.tsx")).toBeNull();
  expect(workflowId(".smithers/workflows/implement.tsx")).toBe("implement");
  expect(workflowId(".smithers/components/Review.tsx")).toBeNull();
});

test("importsComponent matches ../components and ~/components specifiers", () => {
  expect(importsComponent('import { Review } from "../components/Review";', "Review")).toBe(true);
  expect(importsComponent('import { Review } from "~/components/Review";', "Review")).toBe(true);
  expect(importsComponent('import { ReviewPanel, reviewGate } from "../components/Review";', "Review")).toBe(true);
  expect(importsComponent('import { x } from "../components/ReviewOther";', "Review")).toBe(false);
  expect(importsComponent('import { x } from "../components/Other";', "Review")).toBe(false);
});

test("buildComponentImporterMap reverse-maps components to importing workflows", () => {
  const files = [
    { path: ".smithers/components/Review.tsx", contents: "x" },
    { path: ".smithers/components/Plan.tsx", contents: "x" },
    { path: ".smithers/workflows/a.tsx", contents: 'import { Review } from "../components/Review";' },
    { path: ".smithers/workflows/b.tsx", contents: 'import { Plan } from "~/components/Plan";\nimport { Review } from "../components/Review";' },
  ];
  const map = buildComponentImporterMap(files);
  expect(map.get("Review")).toEqual(["a", "b"]);
  expect(map.get("Plan")).toEqual(["b"]);
});

test("init reports drifted pack files; applyWorkflowPackUpdates writes them", () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-init-upd-"));
  const opts = { rootDir: dir, skipInstall: true, installSkill: false, env: seededAgentEnv(dir) };

  const first = initWorkflowPack(opts);
  expect(first.writtenFiles.length).toBeGreaterThan(0);
  expect(first.changedFiles).toEqual([]);

  // A clean re-run finds nothing drifted.
  expect(initWorkflowPack(opts).changedFiles).toEqual([]);

  // Locally edit a seeded workflow; it should be reported as drifted without
  // bringing the removed legacy component suite back into the default pack.
  const workflowPath = join(dir, ".smithers/workflows/create-workflow.tsx");
  writeFileSync(workflowPath, "// locally edited\n", "utf8");
  const third = initWorkflowPack(opts);
  const changed = third.changedFiles.find((f) => f.path === ".smithers/workflows/create-workflow.tsx");
  expect(changed).toBeDefined();
  expect(changed.isComponent).toBe(false);
  expect(changed.importedBy).toEqual([]);

  // init never auto-overwrites: the user's edit survives until applied.
  expect(readFileSync(workflowPath, "utf8")).toContain("locally edited");

  const written = applyWorkflowPackUpdates([changed]);
  expect(written).toContain(workflowPath);
  const after = readFileSync(workflowPath, "utf8");
  expect(after).not.toContain("locally edited");
  expect(after).toContain("<Workflow name=\"create-workflow\">");
}, 30_000);

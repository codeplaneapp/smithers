import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildComponentImporterMap, componentBaseName, importsComponent, workflowId } from "../src/initPackUpdates.js";
import { applyWorkflowPackUpdates, initWorkflowPack } from "../src/workflow-pack.js";

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
  const opts = { rootDir: dir, skipInstall: true, installSkill: false };

  const first = initWorkflowPack(opts);
  expect(first.writtenFiles.length).toBeGreaterThan(0);
  expect(first.changedFiles).toEqual([]);

  // A clean re-run finds nothing drifted.
  expect(initWorkflowPack(opts).changedFiles).toEqual([]);

  // Locally edit a shared component; it should now be reported as drifted, as a
  // shared component, with the workflows that import it.
  const reviewPath = join(dir, ".smithers/components/Review.tsx");
  writeFileSync(reviewPath, "// locally edited\n", "utf8");
  const third = initWorkflowPack(opts);
  const changed = third.changedFiles.find((f) => f.path === ".smithers/components/Review.tsx");
  expect(changed).toBeDefined();
  expect(changed.isComponent).toBe(true);
  expect(changed.importedBy).toContain("implement");
  expect(changed.importedBy).toContain("review");

  // init never auto-overwrites: the user's edit survives until applied.
  expect(readFileSync(reviewPath, "utf8")).toContain("locally edited");

  const written = applyWorkflowPackUpdates([changed]);
  expect(written).toContain(reviewPath);
  const after = readFileSync(reviewPath, "utf8");
  expect(after).not.toContain("locally edited");
  expect(after).toContain("ReviewPanel");
}, 30_000);

import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPackEntry, sharePack } from "../src/share.js";

const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-share-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test("share dry-run builds a registry entry from the TOON manifest and workflow frontmatter", () => {
  const project = temp();
  mkdirSync(join(project, ".smithers", "workflows"), { recursive: true });
  writeFileSync(join(project, ".smithers", "smithers.toon"), [
    "name: kanban-suite",
    "version: 0.3.0",
    "description: Kanban ticket workflows",
    "repository: github.com/someuser/kanban-suite",
    "contents:",
    "  workflows[1]: kanban",
  ].join("\n"));
  writeFileSync(join(project, ".smithers", "workflows", "kanban.tsx"), [
    "// smithers-description: Triage tickets on a live board.",
    "export default null;",
  ].join("\n"));
  const result = sharePack({ from: project, dryRun: true });
  expect(result.entry).toContain("smithers add someuser/kanban-suite");
  expect(result.entry).toContain("`kanban`: Triage tickets on a live board.");
  expect(result.diff).toContain("## Packs");
});

test("share entry includes every workflow described by frontmatter", () => {
  const root = temp();
  mkdirSync(join(root, "workflows"), { recursive: true });
  writeFileSync(join(root, "smithers.toon"), "name: demo\nrepository: acme/demo\n");
  writeFileSync(join(root, "workflows", "one.tsx"), "// smithers-description: First flow\nexport default null;\n");
  expect(buildPackEntry(root).entry).toContain("`one`: First flow");
});

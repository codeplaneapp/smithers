import { expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPackEntry, preparePackForShare, sharePack } from "../src/share.js";

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

test("share dry-run returns the entry and a preview without requiring gh", () => {
  const project = temp();
  mkdirSync(join(project, ".smithers", "workflows"), { recursive: true });
  writeFileSync(join(project, ".smithers", "smithers.toon"), "name: demo\nrepository: acme/demo\n");
  writeFileSync(join(project, ".smithers", "workflows", "demo.tsx"), "// smithers-description: Demo workflow\n");
  const result = sharePack({ from: project, dryRun: true });
  expect(result.dryRun).toBe(true);
  expect(result.entry).toContain("| [demo]");
  expect(result.diff).toContain("README.md");
});

test("share dry-run reads a root-level published-pack manifest and diffs the registry README", () => {
  const pack = temp();
  mkdirSync(join(pack, "workflows"), { recursive: true });
  writeFileSync(join(pack, "smithers.toon"), [
    "name: root-pack",
    "description: Published from the repository root",
    "repository: owner/root-pack",
    "contents:",
    "  workflows[1]: ship",
  ].join("\n"));
  writeFileSync(join(pack, "README.md"), "# Root pack source README\n");
  writeFileSync(join(pack, "workflows", "ship.tsx"), "// smithers-description: Ship the pack\n");
  const result = sharePack({
    from: pack,
    dryRun: true,
    registryReadme: "# Awesome Smithers\n\n## Packs\n\n| Pack | Description | Install | Workflows |\n| --- | --- | --- | --- |\n",
  });
  expect(result.entry).toContain("smithers add owner/root-pack");
  expect(result.diff).toContain("root-pack");
  expect(result.diff).not.toContain("Root pack source README");
});

test("pack preparation strips private files from the pack root only", () => {
  const project = temp();
  mkdirSync(join(project, ".smithers", "workflows"), { recursive: true });
  writeFileSync(join(project, ".smithers", "smithers.toon"), "name: prepared\nrepository: owner/prepared\n");
  writeFileSync(join(project, ".smithers", "smithers.db"), "private");
  writeFileSync(join(project, ".smithers", "agents.ts"), "private");
  mkdirSync(join(project, ".smithers", "agents"), { recursive: true });
  mkdirSync(join(project, ".smithers", "runs"), { recursive: true });
  mkdirSync(join(project, ".smithers", "components"), { recursive: true });
  writeFileSync(join(project, ".smithers", "components", "private.ts"), "private");
  writeFileSync(join(project, ".smithers", "workflows", "ship.tsx"), "export default null;\n");
  writeFileSync(join(project, "project-secret.txt"), "must not be published");
  preparePackForShare({ from: project });
  expect(existsSync(join(project, ".smithers", "smithers.db"))).toBe(false);
  expect(existsSync(join(project, ".smithers", "agents.ts"))).toBe(false);
  expect(existsSync(join(project, ".smithers", "agents"))).toBe(false);
  expect(existsSync(join(project, ".smithers", "runs"))).toBe(false);
  expect(existsSync(join(project, ".smithers", "components"))).toBe(false);
  expect(existsSync(join(project, ".smithers", "README.md"))).toBe(true);
  expect(existsSync(join(project, "project-secret.txt"))).toBe(true);
});

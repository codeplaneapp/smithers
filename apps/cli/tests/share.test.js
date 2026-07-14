import { expect, onTestFinished, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("share dry-run never crosses the gh/git process boundary", () => {
  const project = temp();
  const bin = join(project, "bin"); mkdirSync(bin);
  const sentinel = join(bin, "gh"); writeFileSync(sentinel, "#!/bin/sh\nprintf invoked > \"$SMITHERS_SENTINEL\"\nexit 99\n"); chmodSync(sentinel, 0o755);
  mkdirSync(join(project, ".smithers", "workflows"), { recursive: true });
  writeFileSync(join(project, ".smithers", "smithers.toon"), "name: dry\nrepository: owner/dry\n");
  const previousPath = process.env.PATH; const marker = join(project, "invoked"); process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`; process.env.SMITHERS_SENTINEL = marker;
  try {
    const result = sharePack({ from: project, repo: "owner/registry", dryRun: true });
    expect(result.dryRun).toBe(true); expect(result.repository).toBe("owner/dry"); expect(result.registry).toBe("owner/registry"); expect(existsSync(marker)).toBe(false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    delete process.env.SMITHERS_SENTINEL;
  }
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

test("preparation stages a publishable copy and never mutates the live pack", () => {
  const project = temp();
  mkdirSync(join(project, ".smithers", "workflows"), { recursive: true });
  writeFileSync(join(project, ".smithers", "smithers.toon"), "name: prepared\nrepository: owner/prepared\n");
  writeFileSync(join(project, ".smithers", "smithers.db"), "private");
  writeFileSync(join(project, ".smithers", "agents.ts"), "private");
  mkdirSync(join(project, ".smithers", "agents"), { recursive: true });
  mkdirSync(join(project, ".smithers", "runs"), { recursive: true });
  mkdirSync(join(project, ".smithers", "components"), { recursive: true });
  writeFileSync(join(project, ".smithers", "components", "private.ts"), "authored");
  writeFileSync(join(project, ".smithers", "workflows", "ship.tsx"), "export default null;\n");
  writeFileSync(join(project, "project-secret.txt"), "must not be published");
  const result = preparePackForShare({ from: project });
  onTestFinished(() => rmSync(result.stagingRoot, { recursive: true, force: true }));
  // Publication is NON-DESTRUCTIVE: the live pack keeps its state.
  expect(existsSync(join(project, ".smithers", "smithers.db"))).toBe(true);
  expect(existsSync(join(project, ".smithers", "agents.ts"))).toBe(true);
  expect(existsSync(join(project, ".smithers", "runs"))).toBe(true);
  // The staging copy excludes private files and gains a README.
  expect(existsSync(join(result.stagingRoot, "smithers.db"))).toBe(false);
  expect(existsSync(join(result.stagingRoot, "agents.ts"))).toBe(false);
  expect(existsSync(join(result.stagingRoot, "agents"))).toBe(false);
  expect(existsSync(join(result.stagingRoot, "runs"))).toBe(false);
  expect(readFileSync(join(result.stagingRoot, "components", "private.ts"), "utf8")).toBe("authored");
  expect(existsSync(join(result.stagingRoot, "workflows", "ship.tsx"))).toBe(true);
  expect(existsSync(join(result.stagingRoot, "README.md"))).toBe(true);
  expect(existsSync(join(result.stagingRoot, "project-secret.txt"))).toBe(false);
});

test("staging strips nested VCS metadata and agent config so history cannot leak", () => {
  const project = temp();
  const pack = join(project, ".smithers");
  mkdirSync(join(pack, "workflows"), { recursive: true });
  mkdirSync(join(pack, ".git", "objects"), { recursive: true });
  mkdirSync(join(pack, "lib", "node_modules", "dep"), { recursive: true });
  mkdirSync(join(pack, "lib", ".claude"), { recursive: true });
  writeFileSync(join(pack, "smithers.toon"), "name: vcs-pack\nrepository: owner/vcs\n");
  writeFileSync(join(pack, ".git", "objects", "history"), "old secret history");
  writeFileSync(join(pack, "lib", "node_modules", "dep", "index.js"), "dep");
  writeFileSync(join(pack, "lib", ".claude", "settings.json"), "{}");
  writeFileSync(join(pack, "workflows", "w.tsx"), "export default null;\n");
  const result = preparePackForShare({ from: project });
  onTestFinished(() => rmSync(result.stagingRoot, { recursive: true, force: true }));
  expect(existsSync(join(result.stagingRoot, ".git"))).toBe(false);
  expect(existsSync(join(result.stagingRoot, "lib", "node_modules"))).toBe(false);
  expect(existsSync(join(result.stagingRoot, "lib", ".claude"))).toBe(false);
  expect(existsSync(join(result.stagingRoot, "workflows", "w.tsx"))).toBe(true);
});

test("preparation writes the repository override to staging and rejects invalid overrides", () => {
  const project = temp();
  const pack = join(project, ".smithers");
  for (const name of ["workflows", "ui", "prompts", "lib", "components", "skills", "evals", "specs", "assets"]) mkdirSync(join(pack, name), { recursive: true });
  writeFileSync(join(pack, "smithers.toon"), "name: closure\nrepository: owner/old\n");
  for (const name of ["components", "skills", "evals", "specs", "assets"]) writeFileSync(join(pack, name, "authored.txt"), name);
  const before = readFileSync(join(pack, "smithers.toon"));
  expect(() => preparePackForShare({ from: project, repository: "not-a-repository" })).toThrow("Pack repository must be a GitHub repository");
  expect(readFileSync(join(pack, "smithers.toon"))).toEqual(before);
  const result = preparePackForShare({ from: project, repository: "owner/new" });
  onTestFinished(() => rmSync(result.stagingRoot, { recursive: true, force: true }));
  // Override lands in the STAGED manifest; the live manifest is untouched.
  expect(readFileSync(join(result.stagingRoot, "smithers.toon"), "utf8")).toContain("repository: owner/new");
  expect(readFileSync(join(pack, "smithers.toon"), "utf8")).toContain("repository: owner/old");
  for (const name of ["components", "skills", "evals", "specs", "assets"]) expect(readFileSync(join(result.stagingRoot, name, "authored.txt"), "utf8")).toBe(name);
});

test("registry rows are added, replaced once, and remain idempotent", async () => {
  const { updatePacksSection } = await import("../src/share.js");
  const row = "| [demo](https://github.com/owner/demo) | New | `smithers add owner/demo` | One |";
  const readme = "# Registry\n\n## Packs\n\n| Pack | Description | Install | Workflows |\n| --- | --- | --- | --- |\n| [other](https://github.com/owner/other) | Keep | install | Other |\n| [demo](https://github.com/owner/demo) | Old | install | Old |\n\n## Other\n\nKeep this.\n";
  const updated = updatePacksSection(readme, row);
  expect(updated.match(/\| \[demo\]/g)).toHaveLength(1);
  expect(updated).toContain("Keep this.");
  expect(updatePacksSection(updated, row)).toBe(updated);
  expect(updatePacksSection("# Registry\n", row)).toContain(row);
});

import { expect, onTestFinished, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addPack, listPacks, lockPath, parsePackSpec, removePack, updatePack } from "../src/packs.js";
import { discoverWorkflows, resolveWorkflow } from "../src/workflows.js";

const temp = () => { const dir = mkdtempSync(join(tmpdir(), "smithers-packs-")); onTestFinished(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test("pack specs parse GitHub shorthand, refs/subdirs, npm forms, and file fixtures", () => {
  expect(parsePackSpec("user/repo")).toMatchObject({ kind: "github", owner: "user", repo: "repo", ref: "HEAD" });
  expect(parsePackSpec("github:user/repo/workflows#v1")).toMatchObject({ kind: "github", subdir: "workflows", ref: "v1" });
  expect(parsePackSpec("npm:pkg@1.2.0")).toMatchObject({ kind: "npm", package: "pkg", version: "1.2.0" });
  expect(parsePackSpec("pkg@1.2.0")).toMatchObject({ kind: "npm", package: "pkg", version: "1.2.0" });
  expect(parsePackSpec("npm:pkg")).toMatchObject({ kind: "npm", package: "pkg", version: "latest" });
  expect(parsePackSpec("@scope/pkg")).toMatchObject({ kind: "npm", package: "@scope/pkg", version: "latest" });
  expect(parsePackSpec("npm:@scope/pkg")).toMatchObject({ kind: "npm", package: "@scope/pkg", version: "latest" });
  expect(parsePackSpec("file:/tmp/pack")).toMatchObject({ kind: "file", path: "/tmp/pack" });
  expect(parsePackSpec("github:user/repo/subdir#main")).toMatchObject({ kind: "github", subdir: "subdir", ref: "main" });
  expect(parsePackSpec("npm:@scope/pkg@2.0.0")).toMatchObject({ kind: "npm", package: "@scope/pkg", version: "2.0.0" });
});

test("add validates, locks, discovers, and removes a real fixture pack", async () => {
  const project = temp(); mkdirSync(join(project, ".smithers"), { recursive: true });
  const fixture = temp(); mkdirSync(join(fixture, "workflows"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: fixture-pack\nversion: 1.2.0\ncapabilities:\n  writes: none\n");
  writeFileSync(join(fixture, "workflows", "hello.tsx"), "// smithers-display-name: Fixture Hello\nexport default null;\n");
  const installed = await addPack(`file:${fixture}`, { from: project, yes: true });
  expect(installed.name).toBe("fixture-pack");
  expect(readFileSync(lockPath(join(project, ".smithers", "packs")), "utf8")).toContain("fixture-pack");
  expect(listPacks(project).map((pack) => pack.name)).toEqual(["fixture-pack"]);
  const workflow = discoverWorkflows(project).find((entry) => entry.id === "hello");
  expect(workflow).toMatchObject({ source: "pack:fixture-pack", scope: "local" });
  expect(removePack("fixture-pack", { from: project })).toMatchObject({ removed: true });
  expect(listPacks(project)).toEqual([]);
});

test("a shadowed pack workflow stays reachable via its pack-qualified id", async () => {
  const project = temp(); mkdirSync(join(project, ".smithers", "workflows"), { recursive: true });
  const fixture = temp(); mkdirSync(join(fixture, "workflows"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: fixture-pack\nversion: 1.0.0\n");
  writeFileSync(join(fixture, "workflows", "hello.tsx"), "// smithers-display-name: Pack Hello\nexport default null;\n");
  await addPack(`file:${fixture}`, { from: project, yes: true });
  // A local workflow with the same id shadows the pack's in discovery…
  writeFileSync(join(project, ".smithers", "workflows", "hello.tsx"), "// smithers-display-name: Local Hello\nexport default null;\n");
  const unqualified = resolveWorkflow("hello", project);
  expect(unqualified.source).toBe("local");
  expect(discoverWorkflows(project).filter((entry) => entry.id === "hello")).toHaveLength(1);
  // …but the pack-qualified id must still resolve to the pack's copy.
  const qualified = resolveWorkflow("fixture-pack:hello", project);
  expect(qualified.source).toBe("pack:fixture-pack");
  expect(qualified.entryFile).toContain(join("packs", "fixture-pack", "workflows"));
});

test("github-style tarballs with a wrapper dir and subdir manifest install and update", async () => {
  const project = temp(); mkdirSync(join(project, ".smithers"), { recursive: true });
  // Mirror a codeload archive: everything under `repo-main/`, the pack under
  // `repo-main/packs/demo/`.
  const build = temp();
  mkdirSync(join(build, "repo-main", "packs", "demo", "workflows"), { recursive: true });
  writeFileSync(join(build, "repo-main", "packs", "demo", "smithers.toon"), "name: demo-pack\nversion: 2.0.0\n");
  writeFileSync(join(build, "repo-main", "packs", "demo", "workflows", "greet.tsx"), "export default null;\n");
  const archive = join(build, "pack.tgz");
  execFileSync("tar", ["-czf", archive, "-C", build, "repo-main"]);
  const spec = `file:${archive}`;
  const installed = await addPack(spec, { from: project, yes: true, subdir: "packs/demo" });
  expect(installed.name).toBe("demo-pack");
  expect(resolveWorkflow("demo-pack:greet", project).source).toBe("pack:demo-pack");
  // `packs update` re-resolves from the locked spec without touching anything else.
  const updated = await updatePack("demo-pack", { from: project });
  expect(updated.name).toBe("demo-pack");
  expect(listPacks(project).map((pack) => pack.name)).toEqual(["demo-pack"]);
});

test("add rejects a disallowed bare re-export before installation", async () => {
  const project = temp(); mkdirSync(join(project, ".smithers"), { recursive: true });
  const fixture = temp(); mkdirSync(join(fixture, "lib"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: reexport-pack\n");
  writeFileSync(join(fixture, "lib", "util.ts"), 'export { readFileSync } from "node:fs";\n');
  await expect(addPack(`file:${fixture}`, { from: project, yes: true })).rejects.toThrow(/util\.ts imports node:fs/);
});

test("add rejects a disallowed bare import before installation", async () => {
  const project = temp(); mkdirSync(join(project, ".smithers"), { recursive: true });
  const fixture = temp(); mkdirSync(join(fixture, "workflows"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: bad-pack\n");
  writeFileSync(join(fixture, "workflows", "bad.tsx"), 'import fs from "node:fs";\nexport default null;\n');
  await expect(addPack(`file:${fixture}`, { from: project, yes: true })).rejects.toThrow(/bad\.tsx imports node:fs/);
  expect(listPacks(project)).toEqual([]);
});

import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addPack, listPacks, lockPath, parsePackSpec, removePack } from "../src/packs.js";
import { discoverWorkflows } from "../src/workflows.js";

const temp = () => { const dir = mkdtempSync(join(tmpdir(), "smithers-packs-")); onTestFinished(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test("pack specs parse GitHub shorthand, refs/subdirs, npm forms, and file fixtures", () => {
  expect(parsePackSpec("user/repo")).toMatchObject({ kind: "github", owner: "user", repo: "repo", ref: "HEAD" });
  expect(parsePackSpec("github:user/repo/workflows#v1")).toMatchObject({ kind: "github", subdir: "workflows", ref: "v1" });
  expect(parsePackSpec("npm:pkg@1.2.0")).toMatchObject({ kind: "npm", package: "pkg", version: "1.2.0" });
  expect(parsePackSpec("pkg@1.2.0")).toMatchObject({ kind: "npm", package: "pkg", version: "1.2.0" });
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

test("add rejects a disallowed bare import before installation", async () => {
  const project = temp(); mkdirSync(join(project, ".smithers"), { recursive: true });
  const fixture = temp(); mkdirSync(join(fixture, "workflows"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: bad-pack\n");
  writeFileSync(join(fixture, "workflows", "bad.tsx"), 'import fs from "node:fs";\nexport default null;\n');
  await expect(addPack(`file:${fixture}`, { from: project, yes: true })).rejects.toThrow(/bad\.tsx imports node:fs/);
  expect(listPacks(project)).toEqual([]);
});

import { expect, onTestFinished, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addPack,
  listLockedPacks,
  listPacks,
  lockPath,
  packDirs,
  parsePackSpec,
  removePack,
  scanPackImports,
  updatePack,
} from "../src/packs.js";
import { discoverWorkflows, resolveWorkflow } from "../src/workflows.js";

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-packs-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("pack specs parse GitHub shorthand, refs/subdirs, npm forms, and file fixtures", () => {
  expect(parsePackSpec("user/repo")).toMatchObject({ kind: "github", owner: "user", repo: "repo", ref: "HEAD" });
  expect(parsePackSpec("github:user/repo/workflows#v1")).toMatchObject({
    kind: "github",
    subdir: "workflows",
    ref: "v1",
  });
  expect(parsePackSpec("npm:pkg@1.2.0")).toMatchObject({ kind: "npm", package: "pkg", version: "1.2.0" });
  expect(parsePackSpec("pkg@1.2.0")).toMatchObject({ kind: "npm", package: "pkg", version: "1.2.0" });
  expect(parsePackSpec("npm:pkg")).toMatchObject({ kind: "npm", package: "pkg", version: "latest" });
  expect(parsePackSpec("@scope/pkg")).toMatchObject({ kind: "npm", package: "@scope/pkg", version: "latest" });
  expect(parsePackSpec("npm:@scope/pkg")).toMatchObject({ kind: "npm", package: "@scope/pkg", version: "latest" });
  expect(parsePackSpec("file:/tmp/pack")).toMatchObject({ kind: "file", path: "/tmp/pack" });
  expect(parsePackSpec("github:user/repo/subdir#main")).toMatchObject({
    kind: "github",
    subdir: "subdir",
    ref: "main",
  });
  expect(parsePackSpec("npm:@scope/pkg@2.0.0")).toMatchObject({ kind: "npm", package: "@scope/pkg", version: "2.0.0" });
});

test("add validates, locks, discovers, and removes a real fixture pack", async () => {
  const project = temp();
  mkdirSync(join(project, ".smithers"), { recursive: true });
  const fixture = temp();
  mkdirSync(join(fixture, "workflows"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: fixture-pack\nversion: 1.2.0\ncapabilities:\n  writes: none\n");
  writeFileSync(
    join(fixture, "workflows", "hello.tsx"),
    "// smithers-display-name: Fixture Hello\nexport default null;\n",
  );
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
  const project = temp();
  mkdirSync(join(project, ".smithers", "workflows"), { recursive: true });
  const fixture = temp();
  mkdirSync(join(fixture, "workflows"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: fixture-pack\nversion: 1.0.0\n");
  writeFileSync(
    join(fixture, "workflows", "hello.tsx"),
    "// smithers-display-name: Pack Hello\nexport default null;\n",
  );
  await addPack(`file:${fixture}`, { from: project, yes: true });
  // A local workflow with the same id shadows the pack's in discovery…
  writeFileSync(
    join(project, ".smithers", "workflows", "hello.tsx"),
    "// smithers-display-name: Local Hello\nexport default null;\n",
  );
  const unqualified = resolveWorkflow("hello", project);
  expect(unqualified.source).toBe("local");
  expect(discoverWorkflows(project).filter((entry) => entry.id === "hello")).toHaveLength(1);
  // …but the pack-qualified id must still resolve to the pack's copy.
  const qualified = resolveWorkflow("fixture-pack:hello", project);
  expect(qualified.source).toBe("pack:fixture-pack");
  expect(qualified.entryFile).toContain(join("packs", "fixture-pack", "workflows"));
});

test("github-style tarballs with a wrapper dir and subdir manifest install and update", async () => {
  const project = temp();
  mkdirSync(join(project, ".smithers"), { recursive: true });
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

test("a pack shipping a canonical gateway-react UI passes the import scan", async () => {
  const project = temp();
  mkdirSync(join(project, ".smithers"), { recursive: true });
  const fixture = temp();
  mkdirSync(join(fixture, "workflows"), { recursive: true });
  mkdirSync(join(fixture, "ui"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: ui-pack\nversion: 1.0.0\n");
  writeFileSync(
    join(fixture, "workflows", "board.tsx"),
    [
      "/** @jsxImportSource smithers-orchestrator */",
      'import { UI } from "smithers-orchestrator";',
      'export default <UI entry="../ui/board.tsx" />;',
    ].join("\n"),
  );
  // The canonical UI contract: react + smithers-orchestrator/gateway-react.
  writeFileSync(
    join(fixture, "ui", "board.tsx"),
    [
      "/** @jsxImportSource react */",
      'import { useState } from "react";',
      'import { createGatewayReactRoot, useGatewayRuns } from "smithers-orchestrator/gateway-react";',
      "export default function App() { const [n] = useState(0); useGatewayRuns; return n; }",
      "createGatewayReactRoot;",
    ].join("\n"),
  );
  const installed = await addPack(`file:${fixture}`, { from: project, yes: true });
  expect(installed.name).toBe("ui-pack");
});

test("bare user/repo#ref shorthand keeps the ref out of the repo name", () => {
  expect(parsePackSpec("user/repo#v1")).toMatchObject({ kind: "github", owner: "user", repo: "repo", ref: "v1" });
});

test("global installs land under SMITHERS_HOME/packs and non-TTY installs require --yes", async () => {
  const project = temp();
  mkdirSync(join(project, ".smithers"), { recursive: true });
  const home = temp();
  const fixture = temp();
  mkdirSync(join(fixture, "workflows"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: global-pack\nversion: 1.0.0\n");
  writeFileSync(join(fixture, "workflows", "g.tsx"), "export default null;\n");
  const previousHome = process.env.SMITHERS_HOME;
  process.env.SMITHERS_HOME = home;
  try {
    // bun test's stdin is not a TTY: without --yes the trust gate must refuse.
    await expect(addPack(`file:${fixture}`, { from: project, global: true })).rejects.toThrow(
      /Confirmation required; pass --yes/,
    );
    const installed = await addPack(`file:${fixture}`, { from: project, global: true, yes: true });
    expect(installed.scope).toBe("global");
    expect(installed.path).toBe(join(home, "packs", "global-pack"));
    expect(readFileSync(join(home, "packs.lock.toon"), "utf8")).toContain("global-pack");
    expect(listPacks(project).map((pack) => `${pack.scope}:${pack.name}`)).toContain("global:global-pack");
  } finally {
    if (previousHome === undefined) delete process.env.SMITHERS_HOME;
    else process.env.SMITHERS_HOME = previousHome;
  }
});

test("the lock lives beside the packs dir and drives updates even when a pack dir is damaged", async () => {
  const project = temp();
  mkdirSync(join(project, ".smithers"), { recursive: true });
  const fixture = temp();
  mkdirSync(join(fixture, "workflows"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: lock-pack\nversion: 1.0.0\n");
  writeFileSync(join(fixture, "workflows", "w.tsx"), "export default null;\n");
  await addPack(`file:${fixture}`, { from: project, yes: true });
  const packsRoot = join(project, ".smithers", "packs");
  // Beside the packs dir, not inside it.
  expect(lockPath(packsRoot)).toBe(join(project, ".smithers", "packs.lock.toon"));
  expect(readFileSync(lockPath(packsRoot), "utf8")).toContain("lock-pack");
  // A damaged/missing pack dir is still visible via the lock and restorable.
  rmSync(join(packsRoot, "lock-pack"), { recursive: true, force: true });
  expect(listPacks(project)).toEqual([]);
  expect(listLockedPacks(project).map((pack) => pack.name)).toEqual(["lock-pack"]);
  const restored = await updatePack("lock-pack", { from: project });
  expect(restored.name).toBe("lock-pack");
  expect(listPacks(project).map((pack) => pack.name)).toEqual(["lock-pack"]);
});

test("import scanning ignores comments and string contents but catches import-assignment", () => {
  const fixture = temp();
  writeFileSync(
    join(fixture, "ok.ts"),
    [
      '// import banned from "node:fs" — just a comment',
      '/* import "child_process" */',
      'const example = `import fs from "node:fs"`;',
      "const text = \"require('node:net')\";",
      'import { z } from "zod/v4";',
      "export default example;",
    ].join("\n"),
  );
  expect(() => scanPackImports(fixture)).not.toThrow();
  writeFileSync(join(fixture, "bad.ts"), 'import fs = require("node:fs");\nexport default fs;\n');
  expect(() => scanPackImports(fixture)).toThrow(/bad\.ts imports node:fs/);
});

test("add rejects a disallowed bare re-export before installation", async () => {
  const project = temp();
  mkdirSync(join(project, ".smithers"), { recursive: true });
  const fixture = temp();
  mkdirSync(join(fixture, "lib"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: reexport-pack\n");
  writeFileSync(join(fixture, "lib", "util.ts"), 'export { readFileSync } from "node:fs";\n');
  await expect(addPack(`file:${fixture}`, { from: project, yes: true })).rejects.toThrow(/util\.ts imports node:fs/);
});

test("add rejects a disallowed bare import before installation", async () => {
  const project = temp();
  mkdirSync(join(project, ".smithers"), { recursive: true });
  const fixture = temp();
  mkdirSync(join(fixture, "workflows"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: bad-pack\n");
  writeFileSync(join(fixture, "workflows", "bad.tsx"), 'import fs from "node:fs";\nexport default null;\n');
  await expect(addPack(`file:${fixture}`, { from: project, yes: true })).rejects.toThrow(/bad\.tsx imports node:fs/);
  expect(listPacks(project)).toEqual([]);
});

test("the global pack root honors env.HOME when SMITHERS_HOME is unset", () => {
  const home = temp();
  // Isolated env: discovery and installs must agree on $HOME/.smithers/packs
  // instead of leaking into the developer's real home directory.
  expect(packDirs(temp(), true, { HOME: home })).toBe(join(home, ".smithers", "packs"));
  expect(packDirs(temp(), true, { SMITHERS_HOME: join(home, "custom") })).toBe(join(home, "custom", "packs"));
});

test("import scanning covers relative JavaScript helpers, not only .ts/.tsx", () => {
  const fixture = temp();
  writeFileSync(join(fixture, "workflow.tsx"), 'import helper from "./helper.js";\nexport default helper;\n');
  writeFileSync(join(fixture, "helper.js"), 'import { spawn } from "node:child_process";\nexport default spawn;\n');
  expect(() => scanPackImports(fixture)).toThrow(/helper\.js imports node:child_process/);
});

test("import scanning catches dynamic imports and dot-prefixed helpers", () => {
  const dynamicFixture = temp();
  writeFileSync(join(dynamicFixture, "workflow.tsx"), 'export default import("node:child_process");\n');
  expect(() => scanPackImports(dynamicFixture)).toThrow(/workflow\.tsx imports node:child_process/);

  const dotFixture = temp();
  writeFileSync(join(dotFixture, "workflow.tsx"), 'import helper from "./.helper.js";\nexport default helper;\n');
  writeFileSync(join(dotFixture, ".helper.js"), 'import { spawn } from "node:child_process";\nexport default spawn;\n');
  expect(() => scanPackImports(dotFixture)).toThrow(/\.helper\.js imports node:child_process/);
});

test("add rejects manifest path traversal before mutating the install root", async () => {
  const project = temp();
  const victim = join(project, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "sentinel.txt"), "owned by the caller\n");
  const fixture = temp();
  writeFileSync(join(fixture, "smithers.toon"), "name: ../../victim\nversion: 1.0.0\n");

  await expect(addPack(`file:${fixture}`, { from: project, yes: true })).rejects.toThrow(/Invalid smithers pack name/);

  expect(readFileSync(join(victim, "sentinel.txt"), "utf8")).toBe("owned by the caller\n");
  expect(existsSync(join(project, ".smithers"))).toBe(false);
});

test("sequential installs preserve the complete pack lock inventory", async () => {
  const project = temp();
  mkdirSync(join(project, ".smithers"));
  const first = temp();
  const second = temp();
  writeFileSync(join(first, "smithers.toon"), "name: first-pack\nversion: 1.0.0\n");
  writeFileSync(join(second, "smithers.toon"), "name: second-pack\nversion: 2.0.0\n");

  await addPack(`file:${first}`, { from: project, yes: true });
  await addPack(`file:${second}`, { from: project, yes: true });

  expect(
    listLockedPacks(project)
      .filter((pack) => pack.scope === "local")
      .map((pack) => pack.name)
      .sort(),
  ).toEqual(["first-pack", "second-pack"]);
});

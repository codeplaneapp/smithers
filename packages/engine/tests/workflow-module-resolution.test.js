import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { installWorkflowModuleResolution } from "../src/workflow-module-resolution.js";
import { runWorkflow } from "../src/engine.js";

const require = createRequire(import.meta.url);
const fixtureRoot = mkdtempSync(join(tmpdir(), "smithers-dual-react-"));

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function copyPackage(specifier, destination) {
  const packageJson = require.resolve(`${specifier}/package.json`);
  copyPackageDirectory(dirname(packageJson), destination);
}

function copyPackageDirectory(source, destination) {
  const runtimeState = join(source, ".smithers");
  cpSync(source, destination, {
    recursive: true,
    filter: (entry) => entry !== runtimeState,
  });
}

test("package fixture copies exclude workspace-local Smithers runtime state", () => {
  const source = join(fixtureRoot, "fixture-package");
  const destination = join(fixtureRoot, "fixture-package-copy");
  mkdirSync(join(source, ".smithers"), { recursive: true });
  writeFileSync(join(source, "package.json"), '{"name":"fixture-package"}\n');
  writeFileSync(join(source, ".smithers", "control-plane.db"), "workspace state");

  copyPackageDirectory(source, destination);

  expect(existsSync(join(destination, "package.json"))).toBe(true);
  expect(existsSync(join(destination, ".smithers"))).toBe(false);
});

test("preloaded React remains require-compatible after workflow aliases install", () => {
  const resolutionUrl = new URL("../src/workflow-module-resolution.js", import.meta.url).href;
  const script = [
    'await import("react");',
    `await import(${JSON.stringify(resolutionUrl)});`,
    'await import("data:text/javascript,import React from %22react%22; export default React;");',
    'await import("react-dom/client");',
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: dirname(require.resolve("react/package.json")),
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
});

test("workflow imports use the engine React and Smithers modules over pack-local copies", async () => {
  installWorkflowModuleResolution();
  const packNodeModules = join(fixtureRoot, "pack", "node_modules");
  mkdirSync(join(packNodeModules, "@smthrs"), { recursive: true });
  copyPackage("react", join(packNodeModules, "react"));
  symlinkSync(dirname(require.resolve("zod/package.json")), join(packNodeModules, "zod"));
  copyPackage("@smthrs/components", join(packNodeModules, "@smthrs", "components"));
  copyPackage("smthrs", join(packNodeModules, "smthrs"));

  const workflowPath = join(fixtureRoot, "pack", "workflow.jsx");
  writeFileSync(
    workflowPath,
    [
      "/** @jsxImportSource smthrs */",
      'import React from "react";',
      'import { Task } from "@smthrs/components";',
      'import { createSmithers, Workflow } from "smthrs";',
      'import { z } from "zod";',
      "const { smithers, outputs } = createSmithers({ result: z.object({ ok: z.boolean() }) });",
      'export default smithers(() => <Workflow name="pack-local-react"><Task id="done" output={outputs.result}>{{ ok: true }}</Task></Workflow>);',
      "export { React, Task, createSmithers };",
      "",
    ].join("\n"),
  );

  const packWorkflow = await import(`${pathToFileURL(workflowPath).href}?pack-local`);
  const engineReact = await import(
    pathToFileURL(join(dirname(require.resolve("react/package.json")), "index.js")).href
  );
  const engineComponents = await import(
    pathToFileURL(join(dirname(require.resolve("@smthrs/components/package.json")), "src", "index.js")).href
  );
  const engineSmithers = await import(
    pathToFileURL(join(dirname(require.resolve("smthrs/package.json")), "src", "index.js")).href
  );

  expect(packWorkflow.React).toBe(engineReact.default);
  expect(packWorkflow.Task).toBe(engineComponents.Task);
  expect(packWorkflow.createSmithers).toBe(engineSmithers.createSmithers);
  expect((await Effect.runPromise(runWorkflow(packWorkflow.default, { input: {} }))).status).toBe("finished");
});

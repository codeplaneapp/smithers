import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    cpSync(dirname(packageJson), destination, { recursive: true });
}

test("workflow imports use the engine React and Smithers modules over pack-local copies", async () => {
    installWorkflowModuleResolution();
    const packNodeModules = join(fixtureRoot, "pack", "node_modules");
    mkdirSync(join(packNodeModules, "@smithers-orchestrator"), { recursive: true });
    copyPackage("react", join(packNodeModules, "react"));
    symlinkSync(dirname(require.resolve("zod/package.json")), join(packNodeModules, "zod"));
    copyPackage("@smithers-orchestrator/components", join(packNodeModules, "@smithers-orchestrator", "components"));
    copyPackage("smithers-orchestrator", join(packNodeModules, "smithers-orchestrator"));

    const workflowPath = join(fixtureRoot, "pack", "workflow.jsx");
    writeFileSync(workflowPath, [
        "/** @jsxImportSource smithers-orchestrator */",
        'import React from "react";',
        'import { Task } from "@smithers-orchestrator/components";',
        'import { createSmithers, Workflow } from "smithers-orchestrator";',
        'import { z } from "zod";',
        "const { smithers, outputs } = createSmithers({ result: z.object({ ok: z.boolean() }) });",
        "export default smithers(() => <Workflow name=\"pack-local-react\"><Task id=\"done\" output={outputs.result}>{{ ok: true }}</Task></Workflow>);",
        "export { React, Task, createSmithers };",
        "",
    ].join("\n"));

    const packWorkflow = await import(`${pathToFileURL(workflowPath).href}?pack-local`);
    const engineReact = await import(pathToFileURL(join(dirname(require.resolve("react/package.json")), "index.js")).href);
    const engineComponents = await import(pathToFileURL(join(dirname(require.resolve("@smithers-orchestrator/components/package.json")), "src", "index.js")).href);
    const engineSmithers = await import(pathToFileURL(join(dirname(require.resolve("smithers-orchestrator/package.json")), "src", "index.js")).href);

    expect(packWorkflow.React).toBe(engineReact.default);
    expect(packWorkflow.Task).toBe(engineComponents.Task);
    expect(packWorkflow.createSmithers).toBe(engineSmithers.createSmithers);
    expect((await Effect.runPromise(runWorkflow(packWorkflow.default, { input: {} }))).status).toBe("finished");
});

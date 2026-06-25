/**
 * Guards UI_WORKFLOWS, gateway mounts, ui-files, and e2e descriptors against
 * drift relative to each other.
 *
 * initWorkflowPack() is called into a real temp directory so the generated
 * gateway.ts and ui/*.tsx files are inspected from actual output — not from
 * reading the source constants in isolation.
 */
import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createExecutableDir, writeFakeCodexBinary } from "../../../packages/smithers/tests/e2e-helpers.js";
import { initWorkflowPack } from "../src/workflow-pack.js";

// CI has no agent CLIs/credentials, so agent detection throws NO_USABLE_AGENTS.
// Seed a fake codex binary on PATH plus an OpenAI key so init has one usable
// agent — the same pattern init.e2e.test.js uses. The detected agent set does
// not affect gateway mounts / ui files / descriptors, so this stays deterministic.
function seededAgentEnv() {
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    return {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        OPENAI_API_KEY: "test-openai-key",
        ANTHROPIC_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
    };
}

/**
 * Parse `await mountWorkflow("key", "Title")` calls from the generated
 * gateway.ts and return the mounted workflow descriptors.
 * @param {string} gatewaySource
 * @returns {Array<{ key: string; title: string }>}
 */
function parseMountedWorkflows(gatewaySource) {
    const re = /await mountWorkflow\("([^"]+)", "([^"]+)"\);/g;
    const workflows = [];
    let m;
    while ((m = re.exec(gatewaySource)) !== null) {
        workflows.push({ key: m[1], title: m[2] });
    }
    return workflows;
}

test("UI_WORKFLOWS gateway-mounts / ui-files / e2e-descriptors are in sync", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "smithers-ui-drift-"));
    onTestFinished(() => rmSync(tmpDir, { recursive: true, force: true }));

    // Run a real init so we get the actual generated artefacts.
    // rootDir is the project root; initWorkflowPack appends ".smithers" to it.
    const result = initWorkflowPack({ rootDir: tmpDir, installSkill: false, skipInstall: true, env: seededAgentEnv() });
    expect(result.writtenFiles.length).toBeGreaterThan(0);

    const smithersDir = join(tmpDir, ".smithers");

    // 1. Keys mounted in the generated gateway.ts
    const gatewaySource = readFileSync(join(smithersDir, "gateway.ts"), "utf8");
    const gatewayWorkflows = parseMountedWorkflows(gatewaySource);
    const gatewayKeys = new Set(gatewayWorkflows.map((w) => w.key));
    expect(gatewayKeys.size).toBeGreaterThan(0);

    // 2. Keys with a corresponding .smithers/ui/<key>.tsx file
    const uiFiles = readdirSync(join(smithersDir, "ui"));
    const uiKeys = new Set(
        uiFiles.filter((f) => f.endsWith(".tsx")).map((f) => f.replace(/\.tsx$/, "")),
    );

    // 3. Keys in the e2e descriptor manifest (next to this test file)
    const descriptors = JSON.parse(
        readFileSync(resolve(import.meta.dir, "workflow-ui-descriptors.json"), "utf8"),
    );
    const descriptorByKey = new Map(
        descriptors.map((/** @type {{key:string; title:string}} */ d) => [d.key, d]),
    );
    const descriptorKeys = new Set(descriptorByKey.keys());

    // Every gateway mount must have a ui file and vice versa.
    for (const key of gatewayKeys) {
        expect(uiKeys.has(key), `gateway mounts "${key}" but no ui/${key}.tsx was emitted`).toBe(
            true,
        );
    }
    for (const key of uiKeys) {
        expect(
            gatewayKeys.has(key),
            `ui/${key}.tsx exists but "${key}" is not mounted in gateway.ts`,
        ).toBe(true);
    }

    // Every gateway mount except "kanban" must have an e2e descriptor.
    // (kanban has its own bespoke e2e coverage and is intentionally excluded.)
    for (const key of gatewayKeys) {
        if (key === "kanban") continue;
        expect(
            descriptorKeys.has(key),
            `"${key}" is mounted in gateway.ts but missing from workflow-ui-descriptors.json`,
        ).toBe(true);
    }
    for (const workflow of gatewayWorkflows) {
        if (workflow.key === "kanban") continue;
        expect(
            descriptorByKey.get(workflow.key)?.title,
            `"${workflow.key}" title drifted between gateway mount and workflow-ui-descriptors.json`,
        ).toBe(workflow.title);
    }

    // Every e2e descriptor must correspond to a gateway mount.
    for (const key of descriptorKeys) {
        expect(
            gatewayKeys.has(key),
            `workflow-ui-descriptors.json has "${key}" but it is not mounted in gateway.ts`,
        ).toBe(true);
    }
});

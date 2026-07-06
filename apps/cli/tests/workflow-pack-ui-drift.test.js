/**
 * Guards UI_WORKFLOWS, gateway mounts, workflow-owned <UI> declarations,
 * ui-files, and e2e descriptors against drift relative to each other.
 *
 * initWorkflowPack() is called into a real temp directory so the generated
 * gateway.ts and ui/*.tsx files are inspected from actual output — not from
 * reading the source constants in isolation.
 */
import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutableDir, writeFakeCodexBinary } from "../../../packages/smithers/tests/e2e-helpers.js";
import { initWorkflowPack } from "../src/workflow-pack.js";

const DESCRIPTOR_EXCLUDED_WORKFLOWS = new Set([
    "kanban",
    "hello",
    "create-workflow",
    "context-engineer",
    "route-task",
    "create-skill",
    "extract-skill",
    "triage-run",
    "context-doctor",
    "backpressure-plan",
    "eval-author",
    "report-slideshow",
    "smithering",
    "make-workflow-tutorial",
]);

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
        OPENAI_API_KEY: "sk-test-openai-key",
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

    // 1. Keys mounted in the generated gateway.ts. The gateway must not pass
    // `ui` options anymore; workflow source owns the <UI> declaration.
    const gatewaySource = readFileSync(join(smithersDir, "gateway.ts"), "utf8");
    expect(gatewaySource).not.toContain("ui: { entry:");
    const gatewayWorkflows = parseMountedWorkflows(gatewaySource);
    const gatewayKeys = new Set(gatewayWorkflows.map((w) => w.key));
    expect(gatewayKeys.size).toBeGreaterThan(0);

    // 2. Keys with a corresponding .smithers/ui/<key>.tsx ENTRY file. Seeded
    // multi-file UIs (delegation-chain) also emit helper modules into ui/;
    // any file imported by another emitted ui file is a module, not an entry,
    // so it neither needs a gateway mount nor an e2e descriptor.
    const uiFiles = readdirSync(join(smithersDir, "ui"));
    const uiSourceFiles = uiFiles.filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
    const importedModules = new Set();
    for (const file of uiSourceFiles) {
        const source = readFileSync(join(smithersDir, "ui", file), "utf8");
        const re = /(?:from\s+|import\s*\(\s*)["']\.\/([^"']+)["']/g;
        let m;
        while ((m = re.exec(source)) !== null) {
            importedModules.add(m[1].replace(/\.(tsx|ts)$/, ""));
        }
    }
    const uiKeys = new Set(
        uiFiles
            .filter((f) => f.endsWith(".tsx"))
            .map((f) => f.replace(/\.tsx$/, ""))
            .filter((key) => !importedModules.has(key)),
    );

    // 2b. Keys whose workflow source declares the UI it owns.
    const workflowUiKeys = new Set();
    const workflowsDir = join(smithersDir, "workflows");
    for (const workflow of gatewayWorkflows) {
        const source = readFileSync(join(workflowsDir, `${workflow.key}.tsx`), "utf8");
        if (source.includes(`<UI entry="../ui/${workflow.key}.tsx"`)) {
            workflowUiKeys.add(workflow.key);
        }
    }

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
        expect(
            workflowUiKeys.has(key),
            `gateway mounts "${key}" but workflows/${key}.tsx does not declare <UI entry="../ui/${key}.tsx" />`,
        ).toBe(true);
    }
    for (const key of uiKeys) {
        expect(
            gatewayKeys.has(key),
            `ui/${key}.tsx exists but "${key}" is not mounted in gateway.ts`,
        ).toBe(true);
        expect(
            workflowUiKeys.has(key),
            `ui/${key}.tsx exists but workflows/${key}.tsx does not declare the owned UI`,
        ).toBe(true);
    }

    // Every gateway mount except bespoke UIs must have an e2e descriptor.
    for (const key of gatewayKeys) {
        if (DESCRIPTOR_EXCLUDED_WORKFLOWS.has(key)) continue;
        expect(
            descriptorKeys.has(key),
            `"${key}" is mounted in gateway.ts but missing from workflow-ui-descriptors.json`,
        ).toBe(true);
    }
    for (const workflow of gatewayWorkflows) {
        if (DESCRIPTOR_EXCLUDED_WORKFLOWS.has(workflow.key)) continue;
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

test("seeded-workflow-pack.generated.js does not reference stale model gpt-5.3-codex", () => {
    // smithering.tsx used gpt-5.3-codex; the live model is gpt-5.5. Guard against
    // the model string being re-introduced by any workflow in the generated pack.
    const packPath = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../src/seeded-workflow-pack.generated.js",
    );
    const packSource = readFileSync(packPath, "utf8");
    expect(packSource).not.toContain("gpt-5.3-codex");
});

/**
 * Verifies that selectedWorkflows gates workflow/component/prompt/ui emission
 * and gateway mounts, with transitive dependency resolution.
 *
 * Invariants:
 *  - Infra files (agents.ts, package.json, .gitignore, etc.) are always emitted.
 *  - Only the selected workflows plus required system workflows appear in .smithers/workflows/.
 *  - Only the components transitively needed by the selection appear in .smithers/components/.
 *  - Only the prompts transitively needed by the selection appear in .smithers/prompts/
 *    (plus always-emit utility prompts).
 *  - Gateway mounts == UI file keys == selected workflow IDs.
 */
import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createExecutableDir, writeFakeCodexBinary } from "../../../packages/smithers/tests/e2e-helpers.js";
import { initWorkflowPack, workflowManifestIds } from "../src/workflow-pack.js";

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

/** Parse mounted workflow keys from a generated gateway.ts source. */
function parseMountedWorkflows(gatewaySource) {
    const re = /await mountWorkflow\("([^"]+)", "([^"]+)"\);/g;
    const workflows = [];
    let m;
    while ((m = re.exec(gatewaySource)) !== null) {
        workflows.push({ key: m[1], title: m[2] });
    }
    return workflows;
}

test("fresh default init installs only the curated workflows and complete DDD closure", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "smithers-curated-pack-"));
    onTestFinished(() => rmSync(tmpDir, { recursive: true, force: true }));
    const result = initWorkflowPack({
        rootDir: tmpDir,
        installSkill: false,
        skipInstall: true,
        env: seededAgentEnv(),
    });
    expect(result.writtenFiles.length).toBeGreaterThan(0);

    const smithersDir = join(tmpDir, ".smithers");
    expect(readdirSync(join(smithersDir, "workflows")).filter((f) => f.endsWith(".tsx")).sort()).toEqual([
        "create-skill.tsx",
        "create-workflow.tsx",
        "docs-driven-development.tsx",
        "init.tsx",
        "post-failure.tsx",
        "upgrade.tsx",
    ]);
    expect(workflowManifestIds()).toEqual(["create-workflow", "create-skill", "docs-driven-development"]);
    expect(workflowManifestIds({ includeSystem: true })).toEqual([
        "create-workflow", "create-skill", "docs-driven-development", "init", "post-failure", "upgrade",
    ]);

    const gateway = readFileSync(join(smithersDir, "gateway.ts"), "utf8");
    expect(new Set(parseMountedWorkflows(gateway).map((w) => w.key))).toEqual(
        new Set(["create-workflow", "create-skill", "docs-driven-development"]),
    );
    const uiFiles = readdirSync(join(smithersDir, "ui"));
    const importedUiModules = new Set(uiFiles.filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
        .flatMap((f) => [...readFileSync(join(smithersDir, "ui", f), "utf8").matchAll(/(?:from|import\s*\()\s*["']\.\/([^"']+)/g)]
            .map((m) => m[1].replace(/\.(tsx|ts)$/, ""))));
    expect(new Set(uiFiles.filter((f) => f.endsWith(".tsx")).map((f) => f.replace(/\.tsx$/, ""))
        .filter((key) => !importedUiModules.has(key)))).toEqual(
        new Set(["create-workflow", "create-skill", "docs-driven-development"]),
    );
    expect(uiFiles).toContain("ddd-shared.tsx");
    expect(uiFiles).toContain("ddd-FeaturesTab.tsx");
    expect(readdirSync(join(smithersDir, "lib", "ddd")).sort()).toEqual([
        "auditInputs.ts", "build.ts", "dddAgents.ts", "dddRoot.ts", "featuresSchema.ts", "generateSpecDocs.ts",
        "generateUiModules.ts", "triageCandidates.ts", "validateFeatures.ts",
    ]);
    expect(readFileSync(join(smithersDir, "spec", "features.json"), "utf8")).not.toContain("workflow-authoring");
    const createWorkflow = readFileSync(join(smithersDir, "workflows", "create-workflow.tsx"), "utf8");
    expect(createWorkflow).toContain("id=\"document\"");
    expect(createWorkflow).toContain("id=\"skill-verification\"");
    expect(readFileSync(join(smithersDir, "prompts", "create-workflow-document.mdx"), "utf8"))
        .toContain("Create `{props.skillsDir}/{props.workflowName}.md`");
}, 30_000);

test("selecting a workflow subset installs exactly that subset + transitive deps + infra", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "smithers-subset-"));
    onTestFinished(() => rmSync(tmpDir, { recursive: true, force: true }));

    const selected = ["create-workflow"];
    const result = initWorkflowPack({
        rootDir: tmpDir,
        installSkill: false,
        skipInstall: true,
        env: seededAgentEnv(),
        selectedWorkflows: selected,
    });
    expect(result.writtenFiles.length).toBeGreaterThan(0);

    const smithersDir = join(tmpDir, ".smithers");

    // --- workflows ---
    const workflowDir = join(smithersDir, "workflows");
    const workflowFiles = readdirSync(workflowDir)
        .filter((f) => f.endsWith(".tsx"))
        .map((f) => f.replace(/\.tsx$/, ""));
    // System workflows (durable init, post-failure autopsy, upgrade) are ALWAYS installed
    // regardless of the selection — the closure force-includes them.
    expect(workflowFiles.sort()).toEqual([...selected, "init", "post-failure", "upgrade"].sort());

    // --- components ---
    const componentDir = join(smithersDir, "components");
    const componentFiles = readdirSync(componentDir)
        .filter((f) => f.endsWith(".tsx"))
        .map((f) => f.replace(/\.tsx$/, ""));
    // The curated workflow does not pull legacy component implementations.
    expect(componentFiles).toEqual([]);
    expect(componentFiles).not.toContain("GrillMe");
    expect(componentFiles).not.toContain("ForEachFeature");
    expect(componentFiles).not.toContain("FeatureEnum");

    // --- prompts ---
    const promptDir = join(smithersDir, "prompts");
    const promptFiles = new Set(
        readdirSync(promptDir)
            .filter((f) => f.endsWith(".mdx"))
            .map((f) => f.replace(/\.mdx$/, "")),
    );
    // prompts from transitive deps of selected workflows
    expect(promptFiles.has("create-workflow-clarify")).toBe(true);
    expect(promptFiles.has("create-workflow-document")).toBe(true);
    // NOT prompts only used by unselected workflows
    expect(promptFiles.has("mission-plan")).toBe(false);
    expect(promptFiles.has("merge-tickets")).toBe(false);
    expect(promptFiles.has("grill-me")).toBe(false);

    // --- gateway mounts match selected workflows ---
    const gatewaySource = readFileSync(join(smithersDir, "gateway.ts"), "utf8");
    const mountedKeys = new Set(parseMountedWorkflows(gatewaySource).map((w) => w.key));
    expect(mountedKeys).toEqual(new Set(selected));

    // --- ui files == gateway mounts ---
    const uiDir = join(smithersDir, "ui");
    const uiKeys = new Set(
        readdirSync(uiDir)
            .filter((f) => f.endsWith(".tsx"))
            .map((f) => f.replace(/\.tsx$/, "")),
    );
    expect(uiKeys).toEqual(mountedKeys);

    // --- infra files always present ---
    const writtenRelative = result.writtenFiles.map((f) =>
        relative(smithersDir, f).replace(/\\/g, "/"),
    );
    expect(writtenRelative).toContain("agents.ts");
    expect(writtenRelative).toContain("package.json");
    expect(writtenRelative).toContain(".gitignore");
    expect(writtenRelative).toContain("gateway.ts");
    // The curated authoring workflow does not depend on the legacy role
    // component substrate; DDD owns its provider helper and installs it only
    // with docs-driven-development.
}, 30_000);

// codexAccounts.ts is shared by hand-embedded role components as well as the
// generated smithering workflow, so it remains infrastructure for every subset.

test("default selectedWorkflows (undefined) emits the same set as all-workflow selection", () => {
    const tmpAll = mkdtempSync(join(tmpdir(), "smithers-all-"));
    const tmpDefault = mkdtempSync(join(tmpdir(), "smithers-default-"));
    onTestFinished(() => {
        rmSync(tmpAll, { recursive: true, force: true });
        rmSync(tmpDefault, { recursive: true, force: true });
    });

    const env = seededAgentEnv();
    const allIds = [
        "create-workflow", "create-skill", "docs-driven-development", "init", "post-failure", "upgrade",
    ];

    const resultAll = initWorkflowPack({ rootDir: tmpAll, installSkill: false, skipInstall: true, env, selectedWorkflows: allIds });
    const resultDefault = initWorkflowPack({ rootDir: tmpDefault, installSkill: false, skipInstall: true, env });

    const normalize = (files, root) =>
        files.map((f) => relative(join(root, ".smithers"), f)).sort();

    expect(normalize(resultAll.writtenFiles, tmpAll)).toEqual(
        normalize(resultDefault.writtenFiles, tmpDefault),
    );
}, 30_000);

test("system workflows install even for a tiny explicit subset", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "smithers-system-"));
    onTestFinished(() => rmSync(tmpDir, { recursive: true, force: true }));
    initWorkflowPack({
        rootDir: tmpDir,
        installSkill: false,
        skipInstall: true,
        env: seededAgentEnv(),
        selectedWorkflows: ["hello"],
    });
    const workflowDir = join(tmpDir, ".smithers", "workflows");
    const files = new Set(readdirSync(workflowDir).filter((f) => f.endsWith(".tsx")));
    expect(files.has("init.tsx")).toBe(true);
    expect(files.has("post-failure.tsx")).toBe(true);
    expect(files.has("upgrade.tsx")).toBe(true);
    // And workflowManifestIds excludes them so the wizard never offers them.
    expect(workflowManifestIds()).not.toContain("init");
    expect(workflowManifestIds()).not.toContain("post-failure");
    expect(workflowManifestIds()).not.toContain("upgrade");
    expect(workflowManifestIds({ includeSystem: true })).toContain("init");
    expect(workflowManifestIds({ includeSystem: true })).toContain("upgrade");
}, 30_000);

test("à-la-carte workflow deselection persists across a non-interactive re-init", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "smithers-deselect-"));
    onTestFinished(() => rmSync(tmpDir, { recursive: true, force: true }));
    const env = seededAgentEnv();

    // Interactive-style init: user keeps everything except "ralph".
    const kept = workflowManifestIds().filter((id) => id !== "ralph");
    initWorkflowPack({ rootDir: tmpDir, installSkill: false, skipInstall: true, env, selectedWorkflows: kept });
    const workflowDir = join(tmpDir, ".smithers", "workflows");
    expect(readdirSync(workflowDir)).not.toContain("ralph.tsx");

    // A later NON-interactive re-init (no explicit selection, e.g. `init --yes`
    // or the durable init workflow) must NOT silently re-add the deselected one.
    initWorkflowPack({ rootDir: tmpDir, installSkill: false, skipInstall: true, env });
    const after = readdirSync(workflowDir);
    expect(after).not.toContain("ralph.tsx");
    // System workflows are always present regardless of the marker.
    expect(after).toContain("init.tsx");
    expect(after).toContain("post-failure.tsx");
    expect(after).toContain("upgrade.tsx");
}, 30_000);

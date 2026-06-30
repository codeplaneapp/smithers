/**
 * Verifies that selectedWorkflows gates workflow/component/prompt/ui emission
 * and gateway mounts, with transitive dependency resolution.
 *
 * Invariants:
 *  - Infra files (agents.ts, package.json, .gitignore, etc.) are always emitted.
 *  - Only the selected workflows' .tsx files appear in .smithers/workflows/.
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
import { initWorkflowPack } from "../src/workflow-pack.js";

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

test("selecting a workflow subset installs exactly that subset + transitive deps + infra", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "smithers-subset-"));
    onTestFinished(() => rmSync(tmpDir, { recursive: true, force: true }));

    // Select just implement and plan — covers the core transitive dep chain:
    //   implement → ValidationLoop → Review → review.mdx, implement.mdx, validate.mdx
    //   plan → plan.mdx
    const selected = ["implement", "plan"];
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
    expect(workflowFiles.sort()).toEqual(selected.slice().sort());

    // --- components ---
    const componentDir = join(smithersDir, "components");
    const componentFiles = readdirSync(componentDir)
        .filter((f) => f.endsWith(".tsx"))
        .map((f) => f.replace(/\.tsx$/, ""));
    // implement uses ValidationLoop which pulls in Review transitively
    expect(componentFiles).toContain("ValidationLoop");
    expect(componentFiles).toContain("Review");
    // plan doesn't need GrillMe, ForEachFeature, FeatureEnum, CommandProbe
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
    expect(promptFiles.has("implement")).toBe(true);
    expect(promptFiles.has("validate")).toBe(true);
    expect(promptFiles.has("review")).toBe(true);
    expect(promptFiles.has("plan")).toBe(true);
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
});

test("default selectedWorkflows (undefined) emits the same set as all-workflow selection", () => {
    const tmpAll = mkdtempSync(join(tmpdir(), "smithers-all-"));
    const tmpDefault = mkdtempSync(join(tmpdir(), "smithers-default-"));
    onTestFinished(() => {
        rmSync(tmpAll, { recursive: true, force: true });
        rmSync(tmpDefault, { recursive: true, force: true });
    });

    const env = seededAgentEnv();
    const allIds = [
        "vcs", "implement", "research-plan-implement", "review", "plan", "research",
        "ticket-create", "tickets-create", "ralph", "improve-test-coverage", "debug",
        "grill-me", "feature-enum", "audit", "mission", "workflow-skill", "kanban",
        "hello", "create-workflow", "context-engineer", "route-task", "create-skill",
        "extract-skill", "monitor-smithers", "monitor", "triage-run", "context-doctor",
        "backpressure-plan", "eval-author", "report-slideshow", "smithering",
    ];

    const resultAll = initWorkflowPack({ rootDir: tmpAll, installSkill: false, skipInstall: true, env, selectedWorkflows: allIds });
    const resultDefault = initWorkflowPack({ rootDir: tmpDefault, installSkill: false, skipInstall: true, env });

    const normalize = (files, root) =>
        files.map((f) => relative(join(root, ".smithers"), f)).sort();

    expect(normalize(resultAll.writtenFiles, tmpAll)).toEqual(
        normalize(resultDefault.writtenFiles, tmpDefault),
    );
});

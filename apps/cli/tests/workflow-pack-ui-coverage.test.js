// Guard: every canonical init workflow must ship with a custom UI.
//
// `initWorkflowPack` writes .smithers/workflows/<key>.tsx for each seeded
// workflow and .smithers/ui/<key>.tsx for each workflow that has a custom UI.
// This test asserts the two sets are identical so future workflow additions
// that forget a UI fail here instead of silently shipping without one.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

test("every canonical init workflow ships with a custom UI", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-ui-coverage-"));
    try {
        const { writtenFiles } = initWorkflowPack({
            rootDir: root,
            env: seededAgentEnv(),
            installSkill: false,
            skipInstall: true,
        });
        const smithersRoot = join(root, ".smithers");
        const workflowsDir = join(smithersRoot, "workflows");
        const uiDir = join(smithersRoot, "ui");

        const workflowKeys = writtenFiles
            .filter((f) => f.startsWith(workflowsDir) && f.endsWith(".tsx"))
            .map((f) => relative(workflowsDir, f).replace(/\.tsx$/, ""));

        const uiKeys = new Set(
            writtenFiles
                .filter((f) => f.startsWith(uiDir) && f.endsWith(".tsx"))
                .map((f) => relative(uiDir, f).replace(/\.tsx$/, "")),
        );

        const missing = workflowKeys.filter((key) => !uiKeys.has(key));
        expect(
            missing,
            `Seeded workflows shipped without a custom UI: ${missing.join(", ")}. ` +
            `Add UI source to workflowUiSources.js and register in UI_WORKFLOWS.`,
        ).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

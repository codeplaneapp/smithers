/**
 * Unit tests for the init default-selection helpers.
 *
 * Interactive init asks one question (preferred agent — covered in
 * init-agent-select.test.js); workflows/skills/agent docs install with these
 * defaults. No TTY required.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildSkillOptions,
    buildDefaultSelections,
    selectionsToPackOptions,
    withRequiredWorkflows,
} from "../src/init/interactiveInit.js";
import { workflowManifestIds } from "../src/workflow-pack.js";

// ---------------------------------------------------------------------------
// buildSkillOptions
// ---------------------------------------------------------------------------

describe("buildSkillOptions", () => {
    test("returns an array of skill options", () => {
        const opts = buildSkillOptions({});
        expect(Array.isArray(opts)).toBe(true);
    });

    test("includes the claude and codex targets", () => {
        const ids = buildSkillOptions({}).map((o) => o.id);
        expect(ids).toContain("claude");
        expect(ids).toContain("codex");
    });

    test("every option has an id and a displayName-derived label", () => {
        for (const opt of buildSkillOptions({})) {
            expect(typeof opt.id).toBe("string");
            expect(opt.id.length).toBeGreaterThan(0);
            expect(typeof opt.label).toBe("string");
            expect(opt.label.length).toBeGreaterThan(0);
        }
    });
});

// ---------------------------------------------------------------------------
// buildDefaultSelections
// ---------------------------------------------------------------------------

describe("buildDefaultSelections", () => {
    test("selectedWorkflows includes all non-system manifest workflow IDs", () => {
        const defs = buildDefaultSelections({});
        expect(defs.selectedWorkflows.slice().sort()).toEqual(workflowManifestIds().slice().sort());
    });

    test("system workflows are not part of the default selections", () => {
        const defs = buildDefaultSelections({});
        expect(defs.selectedWorkflows).not.toContain("init");
        expect(defs.selectedWorkflows).not.toContain("post-failure");
        // ...but they DO exist in the full manifest (installed by the closure).
        expect(workflowManifestIds({ includeSystem: true })).toContain("init");
        expect(workflowManifestIds({ includeSystem: true })).toContain("post-failure");
    });

    test("selectedSkillTargets includes the claude target", () => {
        const defs = buildDefaultSelections({});
        expect(defs.selectedSkillTargets).toContain("claude");
    });

    test("selectedAgentDocs includes CLAUDE.md and AGENTS.md", () => {
        const defs = buildDefaultSelections({});
        expect(defs.selectedAgentDocs).toContain("CLAUDE.md");
        expect(defs.selectedAgentDocs).toContain("AGENTS.md");
    });
});

// ---------------------------------------------------------------------------
// selectionsToPackOptions (selection → initWorkflowPack options mapping)
// ---------------------------------------------------------------------------

describe("selectionsToPackOptions", () => {
    test("passes through selectedWorkflows unchanged", () => {
        const sel = {
            selectedWorkflows: ["implement", "review"],
            selectedSkillTargets: ["claude"],
            selectedAgentDocs: ["CLAUDE.md"],
        };
        expect(selectionsToPackOptions(sel).selectedWorkflows).toEqual(["implement", "review"]);
    });

    test("passes through selectedSkillTargets unchanged", () => {
        const sel = {
            selectedWorkflows: [],
            selectedSkillTargets: ["claude", "pi"],
            selectedAgentDocs: [],
        };
        expect(selectionsToPackOptions(sel).selectedSkillTargets).toEqual(["claude", "pi"]);
    });

    test("passes through selectedAgentDocs unchanged", () => {
        const sel = {
            selectedWorkflows: [],
            selectedSkillTargets: [],
            selectedAgentDocs: ["CLAUDE.md"],
        };
        expect(selectionsToPackOptions(sel).selectedAgentDocs).toEqual(["CLAUDE.md"]);
    });

    test("empty selections produce empty arrays", () => {
        const sel = { selectedWorkflows: [], selectedSkillTargets: [], selectedAgentDocs: [] };
        const packed = selectionsToPackOptions(sel);
        expect(packed.selectedWorkflows).toEqual([]);
        expect(packed.selectedSkillTargets).toEqual([]);
        expect(packed.selectedAgentDocs).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// withRequiredWorkflows (force-include for `smithers init "<task>"`)
// ---------------------------------------------------------------------------

describe("withRequiredWorkflows", () => {
    test("force-includes a required workflow missing from the selection", () => {
        const sel = { selectedWorkflows: ["hello"], selectedSkillTargets: [], selectedAgentDocs: [] };
        const out = withRequiredWorkflows(sel, ["create-workflow"]);
        expect(out.selectedWorkflows).toContain("create-workflow");
        expect(out.selectedWorkflows).toContain("hello");
    });

    test("does not duplicate a required workflow already selected", () => {
        const sel = { selectedWorkflows: ["create-workflow", "hello"], selectedSkillTargets: [], selectedAgentDocs: [] };
        const out = withRequiredWorkflows(sel, ["create-workflow"]);
        expect(out.selectedWorkflows.filter((w) => w === "create-workflow")).toHaveLength(1);
    });

    test("returns the selection unchanged when nothing is required", () => {
        const sel = { selectedWorkflows: ["hello"], selectedSkillTargets: [], selectedAgentDocs: [] };
        expect(withRequiredWorkflows(sel, [])).toBe(sel);
        expect(withRequiredWorkflows(sel)).toBe(sel);
    });

    test("preserves the other selection fields", () => {
        const sel = { selectedWorkflows: [], selectedSkillTargets: ["claude"], selectedAgentDocs: ["CLAUDE.md"] };
        const out = withRequiredWorkflows(sel, ["create-workflow"]);
        expect(out.selectedSkillTargets).toEqual(["claude"]);
        expect(out.selectedAgentDocs).toEqual(["CLAUDE.md"]);
        expect(out.selectedWorkflows).toEqual(["create-workflow"]);
    });
});

// ---------------------------------------------------------------------------
// Persisted-deselection seeding (re-init must not wipe earlier opt-outs)
// ---------------------------------------------------------------------------

describe("persisted deselection seeding", () => {
    function tempPackRoot(selections) {
        const dir = mkdtempSync(join(tmpdir(), "smithers-init-seed-"));
        writeFileSync(join(dir, "pack-selections.json"), JSON.stringify(selections), "utf8");
        return dir;
    }

    test("buildDefaultSelections drops workflows deselected in a previous init", () => {
        const packRoot = tempPackRoot({ deselectedWorkflows: ["docs-driven-development"], deselectedAgentDocs: [] });
        try {
            const sel = buildDefaultSelections({}, packRoot);
            expect(sel.selectedWorkflows).not.toContain("docs-driven-development");
            expect(sel.selectedWorkflows).toContain("create-workflow");
            expect(sel.selectedWorkflows).toContain("create-skill");
        } finally {
            rmSync(packRoot, { recursive: true, force: true });
        }
    });

    test("buildDefaultSelections honors agent-doc deselection case-insensitively", () => {
        const packRoot = tempPackRoot({ deselectedWorkflows: [], deselectedAgentDocs: ["agents.md"] });
        try {
            const sel = buildDefaultSelections({}, packRoot);
            expect(sel.selectedAgentDocs).toEqual(["CLAUDE.md"]);
        } finally {
            rmSync(packRoot, { recursive: true, force: true });
        }
    });

    test("buildDefaultSelections drops skill targets the user opted out of", () => {
        const home = mkdtempSync(join(tmpdir(), "smithers-init-home-"));
        try {
            mkdirSync(join(home, ".smithers"), { recursive: true });
            writeFileSync(join(home, ".smithers", "skill-deselections.json"), JSON.stringify({ optedOut: ["pi"] }), "utf8");
            const sel = buildDefaultSelections({ HOME: home });
            expect(sel.selectedSkillTargets).not.toContain("pi");
            expect(sel.selectedSkillTargets).toContain("claude");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});

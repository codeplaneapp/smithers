/**
 * Unit tests for the interactive init selection helpers.
 *
 * These test the pure option-builder functions and the selection-to-options
 * mapping without requiring a real TTY or an OpenTUI renderer.
 */
import { describe, expect, test } from "bun:test";
import {
    buildAgentSetupOptions,
    buildWorkflowOptions,
    buildSkillOptions,
    buildAgentDocOptions,
    buildDefaultSelections,
    selectionsToPackOptions,
} from "../src/init/interactiveInit.js";

// ---------------------------------------------------------------------------
// buildWorkflowOptions
// ---------------------------------------------------------------------------

describe("buildWorkflowOptions", () => {
    test("returns an array of workflow options", () => {
        const opts = buildWorkflowOptions();
        expect(Array.isArray(opts)).toBe(true);
        expect(opts.length).toBeGreaterThan(0);
    });

    test("every option has an id and a label string", () => {
        for (const opt of buildWorkflowOptions()) {
            expect(typeof opt.id).toBe("string");
            expect(opt.id.length).toBeGreaterThan(0);
            expect(typeof opt.label).toBe("string");
            expect(opt.label.length).toBeGreaterThan(0);
        }
    });

    test("includes known core workflows", () => {
        const ids = buildWorkflowOptions().map((o) => o.id);
        expect(ids).toContain("implement");
        expect(ids).toContain("review");
        expect(ids).toContain("hello");
        expect(ids).toContain("create-workflow");
        expect(ids).toContain("smithering");
    });

    test("ids are unique", () => {
        const ids = buildWorkflowOptions().map((o) => o.id);
        expect(ids.length).toBe(new Set(ids).size);
    });

    test("labels are unique", () => {
        const labels = buildWorkflowOptions().map((o) => o.label);
        expect(labels.length).toBe(new Set(labels).size);
    });
});

// ---------------------------------------------------------------------------
// buildAgentSetupOptions
// ---------------------------------------------------------------------------

describe("buildAgentSetupOptions", () => {
    test("includes provider and custom adapter choices", () => {
        const ids = buildAgentSetupOptions().map((o) => o.id);
        expect(ids).toContain("openrouter");
        expect(ids).toContain("claude");
        expect(ids).toContain("codex");
        expect(ids).toContain("opencode");
        expect(ids).toContain("custom");
    });

    test("documents the AgentLike generate contract for custom adapters", () => {
        const custom = buildAgentSetupOptions().find((o) => o.id === "custom");
        expect(custom?.detail).toContain("generate(args)");
        expect(custom?.detail).toContain("return");
    });
});

// ---------------------------------------------------------------------------
// buildSkillOptions
// ---------------------------------------------------------------------------

describe("buildSkillOptions", () => {
    test("returns an array of skill options", () => {
        const opts = buildSkillOptions({});
        expect(Array.isArray(opts)).toBe(true);
    });

    test("includes the claude target", () => {
        const ids = buildSkillOptions({}).map((o) => o.id);
        expect(ids).toContain("claude");
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
// buildAgentDocOptions
// ---------------------------------------------------------------------------

describe("buildAgentDocOptions", () => {
    test("returns CLAUDE.md and AGENTS.md as options", () => {
        const opts = buildAgentDocOptions();
        const filenames = opts.map((o) => o.filename);
        expect(filenames).toContain("CLAUDE.md");
        expect(filenames).toContain("AGENTS.md");
    });

    test("each option has matching filename and label", () => {
        for (const opt of buildAgentDocOptions()) {
            expect(opt.filename).toBe(opt.label);
        }
    });
});

// ---------------------------------------------------------------------------
// buildDefaultSelections
// ---------------------------------------------------------------------------

describe("buildDefaultSelections", () => {
    test("selectedWorkflows includes all workflow IDs", () => {
        const defs = buildDefaultSelections({});
        const all = buildWorkflowOptions().map((o) => o.id);
        expect(defs.selectedWorkflows.sort()).toEqual(all.sort());
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
        expect(packed.scaffoldCustomAgent).toBe(false);
    });

    test("full selections include all workflows from buildWorkflowOptions", () => {
        const defs = buildDefaultSelections({});
        const packed = selectionsToPackOptions(defs);
        const allIds = buildWorkflowOptions().map((o) => o.id);
        expect(packed.selectedWorkflows.sort()).toEqual(allIds.sort());
    });

    test("custom agent setup maps to custom adapter scaffold option", () => {
        const sel = {
            selectedAgentSetup: "custom",
            selectedWorkflows: ["implement"],
            selectedSkillTargets: [],
            selectedAgentDocs: [],
        };
        expect(selectionsToPackOptions(sel).scaffoldCustomAgent).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Selection filtering (simulates user deselecting items)
// ---------------------------------------------------------------------------

describe("selection filtering", () => {
    test("subset selection only includes chosen workflow ids", () => {
        const defs = buildDefaultSelections({});
        const subset = ["implement", "review", "hello"];
        const filtered = { ...defs, selectedWorkflows: subset };
        expect(selectionsToPackOptions(filtered).selectedWorkflows).toEqual(subset);
    });

    test("empty workflow selection produces empty selectedWorkflows", () => {
        const sel = { selectedWorkflows: [], selectedSkillTargets: ["claude"], selectedAgentDocs: ["CLAUDE.md"] };
        expect(selectionsToPackOptions(sel).selectedWorkflows).toHaveLength(0);
    });

    test("no skill targets produces empty selectedSkillTargets", () => {
        const sel = { selectedWorkflows: ["implement"], selectedSkillTargets: [], selectedAgentDocs: ["CLAUDE.md"] };
        expect(selectionsToPackOptions(sel).selectedSkillTargets).toHaveLength(0);
    });
});

import { describe, expect, test } from "bun:test";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";
import {
    STARTER_RECIPES,
    buildStarterGallery,
    findStarterRecipe,
    listStarterRecipes,
    renderStarterGallery,
    starterCommand,
} from "../src/starter-gallery.js";

describe("starter gallery data", () => {
    test("every starter has stable IDs, commands, and required discovery fields", () => {
        const ids = new Set();
        for (const starter of STARTER_RECIPES) {
            expect(starter.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
            expect(ids.has(starter.id)).toBe(false);
            ids.add(starter.id);
            expect(starter.title.length).toBeGreaterThan(8);
            expect(starter.audience.length).toBeGreaterThan(0);
            expect(starter.goals.length).toBeGreaterThan(0);
            expect(starter.workflow).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
            expect(starter.outcome.length).toBeGreaterThan(20);
            expect(starterCommand(starter)).toContain(`smithers workflow run ${starter.workflow} --prompt "`);
        }
    });

    test("finds starters by ID and alias", () => {
        expect(findStarterRecipe("idea-to-prd")?.id).toBe("idea-to-prd");
        expect(findStarterRecipe("prd")?.id).toBe("idea-to-prd");
        expect(findStarterRecipe("missing")).toBeUndefined();
    });

    test("filters by audience, goal, workflow, and tag", () => {
        expect(listStarterRecipes({ audience: "support" }).map((starter) => starter.id)).toContain("customer-incident");
        expect(listStarterRecipes({ goal: "quality" }).map((starter) => starter.id)).toContain("quality-audit");
        expect(listStarterRecipes({ workflow: "debug" }).map((starter) => starter.id)).toEqual(["customer-incident"]);
        expect(listStarterRecipes({ tag: "launch" }).map((starter) => starter.id)).toEqual(["idea-to-prd", "launch-checklist"]);
    });

    test("renders a browsable overview and a detailed starter", () => {
        const overview = renderStarterGallery(buildStarterGallery({ audience: "product" }));
        expect(overview).toContain("Smithers starters");
        expect(overview).toContain("idea-to-prd");
        expect(overview).toContain("Use `smithers starters <id>`");

        const detail = renderStarterGallery(buildStarterGallery({ id: "customer-incident" }));
        expect(detail).toContain("Turn a customer report into a fix path");
        expect(detail).toContain("Before you run it:");
        expect(detail).toContain("smithers workflow run debug");
    });
});

describe("smithers starters command", () => {
    test("prints the starter gallery for people choosing a workflow", () => {
        const repo = createTempRepo();
        const result = runSmithers(["starters", "--audience", "product"], {
            cwd: repo.dir,
            format: null,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Smithers starters");
        expect(result.stdout).toContain("idea-to-prd");
        expect(result.stdout).toContain("smithers workflow run write-a-prd");
    });

    test("emits structured JSON for integrations", () => {
        const repo = createTempRepo();
        const result = runSmithers(["starters", "prd"], {
            cwd: repo.dir,
            format: "json",
        });
        expect(result.exitCode).toBe(0);
        expect(result.json.selected.id).toBe("idea-to-prd");
        expect(result.json.selected.workflow).toBe("write-a-prd");
        expect(result.json.starters).toHaveLength(1);
    });

    test("returns a user-correctable error for unknown starter IDs", () => {
        const repo = createTempRepo();
        const result = runSmithers(["starters", "does-not-exist"], {
            cwd: repo.dir,
            format: "json",
        });
        expect(result.exitCode).toBe(4);
        expect(result.json.code).toBe("STARTER_NOT_FOUND");
        expect(result.json.message).toContain('Run "smithers starters"');
    });
});

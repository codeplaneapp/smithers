import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWorkflowFileRef, loadWorkflowFileRef } from "../src/workflow-file.js";

// Real files on disk in a temp dir inside the package (so module resolution
// works), removed after the suite.
const fixtureRoot = mkdtempSync(join(import.meta.dir, ".tmp-workflow-file-"));
afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
});

/**
 * @param {string} relPath
 * @param {string} source
 * @returns {string} absolute path of the written file
 */
function writeFixture(relPath, source) {
    const abs = join(fixtureRoot, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, source);
    return abs;
}

describe("isWorkflowFileRef", () => {
    test("accepts a { path } object", () => {
        expect(isWorkflowFileRef({ path: "gen/child.tsx" })).toBe(true);
        expect(isWorkflowFileRef({ path: "child.ts", approvedRoot: "/tmp" })).toBe(true);
    });
    test("rejects built workflows, factories, and non-refs", () => {
        expect(isWorkflowFileRef({ build: () => null, opts: {} })).toBe(false);
        expect(isWorkflowFileRef({ path: "x.ts", build: () => null })).toBe(false);
        expect(isWorkflowFileRef(() => ({}))).toBe(false);
        expect(isWorkflowFileRef(null)).toBe(false);
        expect(isWorkflowFileRef("child.tsx")).toBe(false);
        expect(isWorkflowFileRef({ path: 42 })).toBe(false);
        expect(isWorkflowFileRef([])).toBe(false);
    });
});

describe("loadWorkflowFileRef", () => {
    test("loads a workflow module from inside the approved root", async () => {
        const approved = join(fixtureRoot, "approved");
        writeFixture("approved/generated/child.js", "export default { build: () => null, opts: {} };\n");
        const loaded = await loadWorkflowFileRef({ path: "generated/child.js" }, { approvedRoot: approved });
        expect(typeof loaded.workflow.build).toBe("function");
        expect(loaded.path.endsWith(join("approved", "generated", "child.js"))).toBe(true);
    });
    test("a ref-level approvedRoot wins over the caller default", async () => {
        const refRoot = join(fixtureRoot, "ref-root");
        writeFixture("ref-root/child.js", "export default { build: () => null, opts: {} };\n");
        const loaded = await loadWorkflowFileRef({ path: "child.js", approvedRoot: refRoot }, { approvedRoot: join(fixtureRoot, "elsewhere") });
        expect(typeof loaded.workflow.build).toBe("function");
    });
    test("rejects a path that resolves outside the approved root", async () => {
        const approved = join(fixtureRoot, "jail");
        mkdirSync(approved, { recursive: true });
        // A real file OUTSIDE the root: containment, not existence, must reject it.
        writeFixture("outside.js", "export default { build: () => null, opts: {} };\n");
        await expect(loadWorkflowFileRef({ path: "../outside.js" }, { approvedRoot: approved })).rejects.toMatchObject({
            code: "INVALID_INPUT",
        });
    });
    test("rejects a symlink inside the root that escapes it", async () => {
        const approved = join(fixtureRoot, "symlink-jail");
        mkdirSync(approved, { recursive: true });
        const outside = writeFixture("symlink-target.js", "export default { build: () => null, opts: {} };\n");
        symlinkSync(outside, join(approved, "sneaky.js"));
        await expect(loadWorkflowFileRef({ path: "sneaky.js" }, { approvedRoot: approved })).rejects.toMatchObject({
            code: "INVALID_INPUT",
        });
    });
    test("rejects a missing file", async () => {
        const approved = join(fixtureRoot, "approved");
        await expect(loadWorkflowFileRef({ path: "generated/nope.js" }, { approvedRoot: approved })).rejects.toMatchObject({
            code: "INVALID_INPUT",
        });
    });
    test("rejects when no approved root is available at all", async () => {
        await expect(loadWorkflowFileRef({ path: "generated/child.js" }, {})).rejects.toMatchObject({
            code: "INVALID_INPUT",
        });
    });
    test("rejects an unsupported extension", async () => {
        const approved = join(fixtureRoot, "approved");
        writeFixture("approved/not-a-module.json", "{}\n");
        await expect(loadWorkflowFileRef({ path: "not-a-module.json" }, { approvedRoot: approved })).rejects.toMatchObject({
            code: "INVALID_INPUT",
        });
    });
    test("rejects a module without a default export", async () => {
        const approved = join(fixtureRoot, "approved");
        writeFixture("approved/no-default.js", "export const nope = 1;\n");
        await expect(loadWorkflowFileRef({ path: "no-default.js" }, { approvedRoot: approved })).rejects.toMatchObject({
            code: "WORKFLOW_MISSING_DEFAULT",
        });
    });
    test("rejects a default export that was not built with smithers(...)", async () => {
        const approved = join(fixtureRoot, "approved");
        writeFixture("approved/raw-component.js", "export default function RawComponent() { return null; }\n");
        await expect(loadWorkflowFileRef({ path: "raw-component.js" }, { approvedRoot: approved })).rejects.toMatchObject({
            code: "WORKFLOW_NOT_BUILT",
        });
    });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    isOptionLike,
    looksLikeWorkflowPath,
    getExplicitWorkflowPath,
    resolveLocalSmithersBinJs,
    findNearestWorkflowLocalCli,
} from "../src/bin/smithers-delegation.js";

/** @type {string[]} */
const created = [];

function makeTmp() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-bin-test-"));
    created.push(dir);
    return dir;
}

/**
 * Scaffold a minimal local smithers-orchestrator install under `root`:
 *   root/node_modules/smithers-orchestrator/package.json  { bin: { smithers: "bin/smithers.js" } }
 *   root/node_modules/smithers-orchestrator/bin/smithers.js
 *
 * @param {string} root
 * @returns {string} absolute path to the bin file
 */
function scaffoldLocalInstall(root) {
    const pkgDir = join(root, "node_modules", "smithers-orchestrator");
    const binDir = join(pkgDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const binFile = join(binDir, "smithers.js");
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "smithers-orchestrator", bin: { smithers: "bin/smithers.js" } }),
    );
    writeFileSync(binFile, "#!/usr/bin/env bun\nconsole.log('local smithers');");
    return binFile;
}

afterEach(() => {
    for (const dir of created.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("isOptionLike", () => {
    test("returns true for flag-style arguments", () => {
        expect(isOptionLike("--verbose")).toBe(true);
        expect(isOptionLike("-v")).toBe(true);
    });

    test("returns false for normal values", () => {
        expect(isOptionLike("up")).toBe(false);
        expect(isOptionLike("workflow.ts")).toBe(false);
    });
});

describe("looksLikeWorkflowPath", () => {
    test("returns true for recognised workflow extensions", () => {
        expect(looksLikeWorkflowPath("workflow.ts")).toBe(true);
        expect(looksLikeWorkflowPath("workflow.tsx")).toBe(true);
        expect(looksLikeWorkflowPath("./my-flow.js")).toBe(true);
        expect(looksLikeWorkflowPath("path/to/flow.mts")).toBe(true);
    });

    test("returns false for option-like values even with an extension", () => {
        expect(looksLikeWorkflowPath("--file.ts")).toBe(false);
    });

    test("returns false for strings without a recognised extension", () => {
        expect(looksLikeWorkflowPath("run")).toBe(false);
        expect(looksLikeWorkflowPath("graph")).toBe(false);
        expect(looksLikeWorkflowPath("my-workflow.json")).toBe(false);
    });
});

describe("getExplicitWorkflowPath", () => {
    test("returns null for empty args", () => {
        expect(getExplicitWorkflowPath([])).toBeNull();
    });

    test("returns the first arg when it looks like a workflow path", () => {
        expect(getExplicitWorkflowPath(["workflow.ts", "--watch"])).toBe("workflow.ts");
    });

    test("returns path after a WORKFLOW_PATH_COMMAND", () => {
        expect(getExplicitWorkflowPath(["up", "my-flow.ts"])).toBe("my-flow.ts");
        expect(getExplicitWorkflowPath(["graph", "--watch", "my-flow.tsx"])).toBe("my-flow.tsx");
        expect(getExplicitWorkflowPath(["fork", "a.js"])).toBe("a.js");
    });

    test("returns null after a WORKFLOW_PATH_COMMAND with no following path", () => {
        expect(getExplicitWorkflowPath(["up", "--verbose"])).toBeNull();
        expect(getExplicitWorkflowPath(["up"])).toBeNull();
    });

    test("falls through to pick up a path from non-command args", () => {
        // The first arg is a known subcommand (not a workflow path command), then a path.
        expect(getExplicitWorkflowPath(["run", "my-flow.ts"])).toBe("my-flow.ts");
    });

    test("returns null when no path-like arg appears at all", () => {
        expect(getExplicitWorkflowPath(["run", "--verbose"])).toBeNull();
        expect(getExplicitWorkflowPath(["--help"])).toBeNull();
    });
});

describe("resolveLocalSmithersBinJs", () => {
    test("returns null when node_modules/smithers-orchestrator does not exist", () => {
        const tmp = makeTmp();
        expect(resolveLocalSmithersBinJs(tmp)).toBeNull();
    });

    test("returns null when package.json is missing", () => {
        const tmp = makeTmp();
        mkdirSync(join(tmp, "node_modules", "smithers-orchestrator"), { recursive: true });
        expect(resolveLocalSmithersBinJs(tmp)).toBeNull();
    });

    test("returns null when package.json is malformed JSON", () => {
        const tmp = makeTmp();
        const pkgDir = join(tmp, "node_modules", "smithers-orchestrator");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), "not json {{{");
        expect(resolveLocalSmithersBinJs(tmp)).toBeNull();
    });

    test("returns null when bin field is missing", () => {
        const tmp = makeTmp();
        const pkgDir = join(tmp, "node_modules", "smithers-orchestrator");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "smithers-orchestrator" }));
        expect(resolveLocalSmithersBinJs(tmp)).toBeNull();
    });

    test("returns null when bin file does not exist on disk", () => {
        const tmp = makeTmp();
        const pkgDir = join(tmp, "node_modules", "smithers-orchestrator");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(
            join(pkgDir, "package.json"),
            JSON.stringify({ bin: { smithers: "bin/missing.js" } }),
        );
        expect(resolveLocalSmithersBinJs(tmp)).toBeNull();
    });

    test("resolves bin from { bin: { smithers: '...' } } object form", () => {
        const tmp = makeTmp();
        const binFile = scaffoldLocalInstall(tmp);
        expect(resolveLocalSmithersBinJs(tmp)).toBe(binFile);
    });

    test("resolves bin from { bin: '...' } string form", () => {
        const tmp = makeTmp();
        const pkgDir = join(tmp, "node_modules", "smithers-orchestrator");
        const binDir = join(pkgDir, "bin");
        mkdirSync(binDir, { recursive: true });
        const binFile = join(binDir, "smithers.js");
        writeFileSync(
            join(pkgDir, "package.json"),
            JSON.stringify({ bin: "bin/smithers.js" }),
        );
        writeFileSync(binFile, "#!/usr/bin/env bun");
        expect(resolveLocalSmithersBinJs(tmp)).toBe(binFile);
    });
});

describe("findNearestWorkflowLocalCli", () => {
    test("returns null when no local install exists in any ancestor", () => {
        const tmp = makeTmp();
        mkdirSync(join(tmp, "deep", "dir"), { recursive: true });
        expect(
            findNearestWorkflowLocalCli(tmp, "deep/dir/workflow.ts"),
        ).toBeNull();
    });

    test("finds a local install in the workflow file's own directory", () => {
        const tmp = makeTmp();
        const workflowDir = join(tmp, "project");
        mkdirSync(workflowDir, { recursive: true });
        const binFile = scaffoldLocalInstall(workflowDir);
        expect(
            findNearestWorkflowLocalCli(tmp, "project/workflow.ts"),
        ).toBe(binFile);
    });

    test("walks up ancestors until it finds a local install", () => {
        const tmp = makeTmp();
        const projectDir = join(tmp, "project");
        const deepDir = join(projectDir, "sub", "deep");
        mkdirSync(deepDir, { recursive: true });
        const binFile = scaffoldLocalInstall(projectDir);
        // workflow is inside deepDir but the install is two levels up
        expect(
            findNearestWorkflowLocalCli(tmp, "project/sub/deep/workflow.ts"),
        ).toBe(binFile);
    });

    test("prefers the closest ancestor", () => {
        const tmp = makeTmp();
        const outerDir = join(tmp, "outer");
        const innerDir = join(outerDir, "inner");
        mkdirSync(innerDir, { recursive: true });
        scaffoldLocalInstall(outerDir);
        const innerBin = scaffoldLocalInstall(innerDir);
        expect(
            findNearestWorkflowLocalCli(tmp, "outer/inner/workflow.ts"),
        ).toBe(innerBin);
    });
});

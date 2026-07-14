import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { buildDefaultManifest, loadManifest, parseManifest, renderManifest } from "../src/manifest.js";
import { initWorkflowPack } from "../src/workflow-pack.js";
import { createExecutableDir, writeFakeCodexBinary } from "../../../packages/smithers/tests/e2e-helpers.js";

function seededAgentEnv() {
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    return { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, OPENAI_API_KEY: "sk-test-openai-key" };
}

function tempProject() {
    const root = mkdtempSync(join(tmpdir(), "smithers-manifest-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

test("smithers.toon parses and renders losslessly", () => {
    const manifest = parseManifest([
        "name: kanban-suite",
        "version: 0.3.0",
        "description: Ticket workflows",
        "repository: github.com/example/kanban-suite",
        'smithers: ">=0.28"',
        "contents:",
        "  workflows[2]: kanban,ticket-fleet",
        "  ui[1]: kanban",
        "capabilities:",
        "  bins[1]: git",
        "  env[0]:",
        "  writes: repo",
    ].join("\n"));
    expect(parseManifest(renderManifest(manifest))).toEqual(manifest);
});

test("manifest validation supplies defaults for optional fields", () => {
    expect(parseManifest("name: minimal")).toEqual({
        name: "minimal",
        version: "0.0.0",
        description: "",
        repository: "",
        smithers: "*",
        contents: { workflows: [], ui: [] },
        capabilities: { bins: [], env: [], writes: "none" },
    });
});

test("malformed TOON and missing names fail clearly", () => {
    expect(() => parseManifest("name: broken\nworkflows[2]: one")).toThrow(/Invalid smithers\.toon: malformed TOON/);
    expect(() => parseManifest("version: 1.0.0")).toThrow(/Invalid smithers\.toon: missing required name/);
});

test("present non-object contents and capabilities fail clearly", () => {
    expect(() => parseManifest("name: broken\ncontents: nope")).toThrow(/Invalid smithers\.toon: contents must be an object/);
    expect(() => parseManifest("name: broken\ncapabilities: nope")).toThrow(/Invalid smithers\.toon: capabilities must be an object/);
    expect(() => parseManifest("name: broken\ncontents[1]: nope")).toThrow(/Invalid smithers\.toon: contents must be an object/);
    expect(() => parseManifest("name: broken\ncapabilities[1]: nope")).toThrow(/Invalid smithers\.toon: capabilities must be an object/);
});

test("present null values fail schema validation instead of receiving defaults", () => {
    expect(() => parseManifest("name: broken\nversion: null")).toThrow(/version must be a string/);
    expect(() => parseManifest("name: broken\ncontents:\n  workflows: null")).toThrow(/contents\.workflows must be an array of strings/);
    expect(() => parseManifest("name: broken\ncapabilities:\n  bins: null")).toThrow(/capabilities\.bins must be an array of strings/);
    expect(() => parseManifest("name: broken\ncapabilities:\n  writes: null")).toThrow(/capabilities\.writes must be one of/);
});

test("init scaffolds a manifest enumerating the generated workflows and UIs", () => {
    const root = tempProject();
    const result = initWorkflowPack({ rootDir: root, installSkill: false, skipInstall: true, env: seededAgentEnv() });
    const path = join(root, ".smithers", "smithers.toon");
    expect(result.writtenFiles).toContain(path);
    const manifest = loadManifest(path);
    expect(manifest.name).toBe(basename(root));
    expect(manifest.version).toBe("0.0.0");
    expect(manifest.contents.workflows).toEqual([
        "create-skill",
        "create-workflow",
        "docs-driven-development",
        "eval-suite-run",
        "init",
        "post-failure",
        "upgrade",
    ]);
    expect(manifest.contents.ui).toEqual(["create-skill", "create-workflow", "docs-driven-development"]);
}, 30_000);

test("re-init reports drift for a customized manifest", () => {
    const root = tempProject();
    const options = { rootDir: root, installSkill: false, skipInstall: true, env: seededAgentEnv() };
    initWorkflowPack(options);
    const path = join(root, ".smithers", "smithers.toon");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n# customized\n`, "utf8");
    const result = initWorkflowPack(options);
    expect(result.changedFiles.map((file) => file.path)).toContain(".smithers/smithers.toon");
}, 30_000);

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initOptions } from "../src/init-command.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");
const DOCS_CLI_OVERVIEW = resolve(REPO_ROOT, "docs/cli/overview.mdx");
const DOCS_MEMORY_CONCEPT = resolve(REPO_ROOT, "docs/concepts/memory.mdx");

const GROUPS_WITH_DOTTED_DOCS = new Set([
    "agents",
    "cron",
    "memory",
    "openapi",
    "token",
    "workflow",
    "skills",
]);

function runHelp(args) {
    const result = spawnSync(process.execPath, ["run", CLI_ENTRY, ...args, "--help"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(`help failed for ${args.join(" ")}:\nstdout:${result.stdout}\nstderr:${result.stderr}`);
    }
    return result.stdout;
}

function parseCommands(helpText) {
    const commands = [];
    let inCommands = false;
    for (const line of helpText.split(/\r?\n/)) {
        if (line.trim() === "Commands:") {
            inCommands = true;
            continue;
        }
        if (!inCommands) continue;
        if (!line.trim()) break;
        const match = /^  ([a-z][a-z0-9-]*)\s{2,}/.exec(line);
        if (match) commands.push(match[1]);
    }
    return commands;
}

function documentedCommandNames(markdown) {
    return new Set(
        [...markdown.matchAll(/^  - name: ([a-z][a-z0-9.-]*)$/gm)].map((match) => match[1]),
    );
}

test("CLI overview documents every current CLI command", () => {
    const markdown = readFileSync(DOCS_CLI_OVERVIEW, "utf8");
    const documented = documentedCommandNames(markdown);
    const topLevelCommands = parseCommands(runHelp([]));

    for (const command of topLevelCommands) {
        const documentedDirectly = documented.has(command);
        const documentedAsGroup = [...documented].some((entry) => entry.startsWith(`${command}.`));
        expect(documentedDirectly || documentedAsGroup).toBe(true);
    }

    for (const group of GROUPS_WITH_DOTTED_DOCS) {
        for (const command of parseCommands(runHelp([group]))) {
            expect(documented.has(`${group}.${command}`)).toBe(true);
        }
    }

    expect(documented.has("completions")).toBe(true);
    expect(documented.has("mcp.add")).toBe(true);
    expect(documented.has("tui")).toBe(false);
    expect(documented.has("memory.recall")).toBe(false);
    expect(readFileSync(DOCS_MEMORY_CONCEPT, "utf8")).not.toContain("smithers-orchestrator memory recall");
}, 30_000);

/** Extract the flag names documented for a command in the TOON catalog. */
function documentedFlags(markdown, command) {
    const lines = markdown.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === `- name: ${command}`);
    if (start < 0) throw new Error(`command not documented: ${command}`);
    const flags = [];
    let inFlags = false;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith("- name:")) break;
        if (/^\s*flags\[\d+\]\{/.test(line)) { inFlags = true; continue; }
        if (!inFlags) continue;
        const match = /^\s{6}([a-z][a-z0-9-]*),/.exec(line);
        if (match) flags.push(match[1]);
        else if (line.trim().length > 0 && !/^\s{6}/.test(line)) break;
    }
    return flags;
}

const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

test("CLI overview documents every init flag (guards the stale-flag drift)", () => {
    const markdown = readFileSync(DOCS_CLI_OVERVIEW, "utf8");
    const documented = documentedFlags(markdown, "init").sort();
    const expected = Object.keys(initOptions.shape).map(kebab).sort();
    expect(documented).toEqual(expected);
});

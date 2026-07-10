import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "../../..");
const cliSrcRoot = resolve(repoRoot, "apps/cli/src");
// buildInlineChatWorkflow carved the inline auto-hijacked chat/tutorial
// workflow (and its workspace sqlite open) out of index.js.
const allowedDirectDatabaseOpeners = new Set(["apps/cli/src/buildInlineChatWorkflow.js"]);

function repoRelative(path) {
    return relative(repoRoot, path).split(sep).join("/");
}

function sourceFilesUnder(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "tests" || entry.name === "node_modules" || entry.name === "dist") {
                continue;
            }
            files.push(...sourceFilesUnder(path));
            continue;
        }
        if (entry.isFile() && /\.(js|ts)$/.test(entry.name)) {
            files.push(path);
        }
    }
    return files;
}

describe("CLI DB encapsulation boundary", () => {
    test("does not open sqlite databases outside approved entry points", () => {
        const directOpeners = sourceFilesUnder(cliSrcRoot)
            .filter((file) => readFileSync(file, "utf8").includes("new Database("))
            .map(repoRelative)
            .sort();

        expect(directOpeners).toEqual([...allowedDirectDatabaseOpeners].sort());
    });
});

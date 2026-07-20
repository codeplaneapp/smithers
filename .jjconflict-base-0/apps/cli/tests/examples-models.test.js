import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const EXAMPLES_DIR = resolve(REPO_ROOT, "examples");
const STALE_SONNET_MODELS = [
    "claude-sonnet-4-20250514",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-7",
];

// Skip gitignored runtime/output directories. They hold past-run execution
// logs and databases (e.g. `.smithers/executions/*/logs/stream.ndjson`,
// `swe-evo/.data/*.db`) that legitimately record whatever model a historical
// run used, never exist on a clean checkout, and are not example sources. The
// test guards committed example workflows, so it must scan source only.
const SKIP_DIRS = new Set(["node_modules", "dist", "build"]);

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".") || SKIP_DIRS.has(entry)) {
            continue;
        }
        const path = join(dir, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) {
            files.push(...listFiles(path));
            continue;
        }
        if (stat.isFile()) {
            files.push(path);
        }
    }
    return files;
}

test("example workflows do not reference retired Claude Sonnet model ids", () => {
    const staleReferences = listFiles(EXAMPLES_DIR)
        .flatMap((path) => {
            const contents = readFileSync(path, "utf8");
            return STALE_SONNET_MODELS.filter((model) =>
                contents.includes(model),
            ).map((model) => `${relative(REPO_ROOT, path)}: ${model}`);
        })
        .sort();

    expect(staleReferences).toEqual([]);
});

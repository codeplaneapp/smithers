import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const EXAMPLES_DIR = resolve(REPO_ROOT, "examples");
const STALE_SONNET_MODELS = [
    "claude-sonnet-4-20250514",
    "claude-sonnet-4-5",
    "claude-sonnet-4-7",
];

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir)) {
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

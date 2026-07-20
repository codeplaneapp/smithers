import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const TSCONFIG_PATH = resolve(REPO_ROOT, "examples/tsconfig.json");

test("examples typecheck resolves smithers-orchestrator through package-published types", () => {
    const config = JSON.parse(readFileSync(TSCONFIG_PATH, "utf8"));
    const paths = config.compilerOptions?.paths ?? {};

    for (const specifier of [
        "smithers-orchestrator",
        "smithers-orchestrator/jsx-runtime",
        "smithers-orchestrator/jsx-dev-runtime",
        "smithers-orchestrator/tools",
        "smithers-orchestrator/scorers",
        "smithers-orchestrator/*",
    ]) {
        expect(Object.hasOwn(paths, specifier), `${specifier} should resolve through package exports`).toBe(false);
    }

    for (const [specifier, targets] of Object.entries(paths)) {
        expect(specifier, "examples tsconfig must not override smithers-orchestrator package exports").not.toMatch(/^smithers-orchestrator(?:\/|$)/);
        for (const target of targets) {
            expect(target, `${specifier} should not typecheck against raw smithers package JS`).not.toMatch(/\.\.\/packages\/smithers\/src\/.*\.js$/);
            expect(target, `${specifier} should not use the examples-only runtime entrypoint`).not.toContain("examples-entry");
        }
    }

    expect(config.include).toEqual(["**/*"]);
});

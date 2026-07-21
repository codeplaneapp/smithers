import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_SEEDED_FILES } from "../src/seeded-workflow-pack.generated.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

// The init pack ships generator-seeded workflows from the canonical .smithers/
// sources via scripts/generate-workflow-pack.ts. Guard against drift: the
// committed generated module must match the source files byte-for-byte, so
// editing a seeded workflow/prompt without regenerating fails here instead of
// silently shipping a stale workflow to `smithers init`.
test("generated seeded pack matches canonical .smithers sources", () => {
    expect(GENERATED_SEEDED_FILES.length).toBeGreaterThan(0);
    for (const file of GENERATED_SEEDED_FILES) {
        // DDD's generated UI/spec modules are deliberately replaced with an
        // empty target starter by the pack generator; shipping this repo's
        // product spec would contaminate another project's init.
        if (file.path === ".smithers/spec/features.json" || file.path === ".smithers/spec/content/overview.md" ||
            file.path.includes("ddd-features.generated") || file.path.includes("ddd-docsContent.generated") ||
            file.path.includes("ddd-ticketsBacklog.generated") || file.path.includes("ddd-workflowSource.generated")) continue;
        // file.path is ".smithers/…"-prefixed, relative to the repo root.
        const source = readFileSync(resolve(REPO_ROOT, file.path), "utf8");
        expect(
            file.contents,
            `${file.path} is stale — re-run: bun scripts/generate-workflow-pack.ts`,
        ).toBe(source);
    }
});

test("seeded create-workflow theme ships the AA semantic ramp", () => {
    const theme = GENERATED_SEEDED_FILES.find((file) => file.path === ".smithers/ui/cw-theme.ts");
    expect(theme).toBeDefined();
    expect(theme.contents).toContain("--success:#087461; --danger:#c5343f; --warning:#955600");
    expect(theme.contents).toContain(".smithers-node-agent { border-left-color:var(--success); }");
    for (const stale of ["#0f8f78", "#e5484d", "#bf7100"]) {
        expect(theme.contents).not.toContain(stale);
        expect(GENERATED_SEEDED_FILES.every((file) => !file.contents.includes(stale))).toBe(true);
    }
});

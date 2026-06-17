import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

function readRepoFile(path) {
    return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

test("watch-and-steer guide only documents in-scope UI surfaces", () => {
    const guide = readRepoFile("docs/guide/watch-and-steer.mdx");

    expect(guide).toContain("bunx smithers-orchestrator ui");
    expect(guide).toContain("Smithers workflow UI surface");
    expect(guide).toContain("no GUI required");
    expect(guide).toContain("not a GUI");
    expect(guide).not.toContain("Studio");
    expect(guide).not.toContain("PWA");
    expect(guide).not.toContain("web app");
    expect(guide).not.toContain("pnpm dev:studio");
    expect(guide).not.toContain("/images/studio-2/");
    expect(guide).not.toContain("/images/0.23.0/smithers-pwa.png");
});

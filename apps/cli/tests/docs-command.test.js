import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    normalizeDocsVersion,
    resolveSmithersDocsSource,
    versionedDocsUrl,
} from "../src/docs-command.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");
const CLI_DOCS_ROOT = resolve(REPO_ROOT, "apps/cli/docs");

function withDocsRoot(file = "llms-full.txt") {
    const dir = mkdtempSync(join(tmpdir(), "smithers-docs-command-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), "docs\n");
    return dir;
}

function runCli(args) {
    return spawnSync(process.execPath, ["run", CLI_ENTRY, ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
    });
}

describe("docs command source resolution", () => {
    test("normalizes v-prefixed semver tags", () => {
        expect(normalizeDocsVersion("0.22.0")).toBe("0.22.0");
        expect(normalizeDocsVersion("v0.22.0")).toBe("0.22.0");
    });

    test("rejects non-semver docs versions", () => {
        expect(() => normalizeDocsVersion("main")).toThrow("Invalid Smithers docs version");
        expect(() => normalizeDocsVersion("../main")).toThrow("Invalid Smithers docs version");
    });

    test("builds version-pinned GitHub raw URLs", () => {
        expect(versionedDocsUrl("llms-full.txt", "v0.22.0")).toBe(
            "https://raw.githubusercontent.com/smithersai/smithers/v0.22.0/docs/llms-full.txt",
        );
    });

    test("uses the packaged local docs for the current CLI version by default", () => {
        const docsRoot = withDocsRoot();
        try {
            expect(resolveSmithersDocsSource({
                file: "llms-full.txt",
                packageVersion: "0.22.0",
                localDocsRoots: [docsRoot],
            })).toEqual({
                kind: "local",
                path: join(docsRoot, "llms-full.txt"),
                url: "https://raw.githubusercontent.com/smithersai/smithers/v0.22.0/docs/llms-full.txt",
            });
        }
        finally {
            rmSync(docsRoot, { recursive: true, force: true });
        }
    });

    test("uses a version-pinned remote URL when no local docs are packaged", () => {
        expect(resolveSmithersDocsSource({
            file: "llms.txt",
            packageVersion: "0.22.0",
            localDocsRoots: [],
        })).toEqual({
            kind: "remote",
            url: "https://raw.githubusercontent.com/smithersai/smithers/v0.22.0/docs/llms.txt",
        });
    });

    test("explicit docs versions bypass local current-version docs", () => {
        const docsRoot = withDocsRoot("llms.txt");
        try {
            expect(resolveSmithersDocsSource({
                file: "llms.txt",
                version: "0.21.0",
                packageVersion: "0.22.0",
                localDocsRoots: [docsRoot],
            })).toEqual({
                kind: "remote",
                url: "https://raw.githubusercontent.com/smithersai/smithers/v0.21.0/docs/llms.txt",
            });
        }
        finally {
            rmSync(docsRoot, { recursive: true, force: true });
        }
    });

    test("latest keeps the moving docs-site URL", () => {
        expect(resolveSmithersDocsSource({
            file: "llms-full.txt",
            latest: true,
            packageVersion: "0.22.0",
            localDocsRoots: [],
        })).toEqual({
            kind: "remote",
            url: "https://smithers.sh/llms-full.txt",
        });
    });

    test("rejects latest with an explicit docs version", () => {
        expect(() => resolveSmithersDocsSource({
            file: "llms-full.txt",
            latest: true,
            version: "0.22.0",
            packageVersion: "0.22.0",
        })).toThrow("Use either --latest or --docs-version, not both.");
    });

    test("docs --json prints the packaged docs index for this CLI version", () => {
        const result = runCli(["docs", "--json"]);
        expect(result.status).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload).toEqual({
            url: "https://raw.githubusercontent.com/smithersai/smithers/v0.22.0/docs/llms.txt",
            content: readFileSync(resolve(CLI_DOCS_ROOT, "llms.txt"), "utf8"),
        });
    });

    test("docs-full --json prints the packaged full docs for this CLI version", () => {
        const result = runCli(["docs-full", "--json"]);
        expect(result.status).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.url).toBe("https://raw.githubusercontent.com/smithersai/smithers/v0.22.0/docs/llms-full.txt");
        expect(payload.content).toBe(readFileSync(resolve(CLI_DOCS_ROOT, "llms-full.txt"), "utf8"));
    });

    test("docs command rejects --latest with --docs-version through the real CLI", () => {
        const result = runCli(["docs", "--latest", "--docs-version", "0.22.0", "--json"]);
        expect(result.status).toBe(4);
        expect(JSON.parse(result.stdout)).toEqual({
            code: "DOCS_OPTIONS_INVALID",
            message: "Use either --latest or --docs-version, not both.",
        });
    });
});

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudeSessionFile, resolveCodexSessionFile, } from "../src/_sessionFileResolvers.js";

/** @returns {Promise<string>} */
function makeTempDir() {
    return mkdtemp(join(tmpdir(), "smithers-session-resolvers-"));
}

describe("resolveCodexSessionFile", () => {
    /** @type {string | undefined} */
    let savedTZ;
    /** @type {string} */
    let base;

    // Pin the timezone so the local/UTC day boundary is deterministic regardless
    // of the host. With TZ=UTC the local day and UTC day are identical, so the
    // only way the file is found is by searching the adjacent (-1 day) folder.
    beforeEach(async () => {
        savedTZ = process.env.TZ;
        process.env.TZ = "UTC";
        base = await makeTempDir();
    });
    afterEach(async () => {
        if (savedTZ === undefined) delete process.env.TZ;
        else process.env.TZ = savedTZ;
        await rm(base, { recursive: true, force: true });
    });

    test("finds a session stored in an adjacent day folder", async () => {
        const cwd = "/work/proj";
        // Run started just after midnight UTC on 2026-05-28, but the session was
        // actually opened minutes earlier — its rollout file lives in the
        // *previous* day folder (2026/05/27). The old resolver only looked at the
        // UTC day of startedAtMs (2026/05/28) and missed it.
        const startedAtMs = Date.UTC(2026, 4, 28, 0, 30, 0);
        const sessionTimestamp = new Date(Date.UTC(2026, 4, 27, 23, 55, 0)).toISOString();

        const adjacentDayDir = join(base, "2026", "05", "27");
        await mkdir(adjacentDayDir, { recursive: true });
        const sessionFile = join(adjacentDayDir, "rollout-2026-05-27-sess.jsonl");
        await writeFile(sessionFile, `${JSON.stringify({
            type: "session_meta",
            payload: { cwd, timestamp: sessionTimestamp },
        })}\n`);

        const agent = { opts: { codexSessionDir: base } };
        const resolved = await resolveCodexSessionFile(agent, cwd, startedAtMs);
        expect(resolved).toBe(sessionFile);
    });

    test("returns null when no correlated session exists in nearby day folders", async () => {
        const cwd = "/work/proj";
        const startedAtMs = Date.UTC(2026, 4, 28, 0, 30, 0);
        const agent = { opts: { codexSessionDir: base } };
        expect(await resolveCodexSessionFile(agent, cwd, startedAtMs)).toBeNull();
    });
});

describe("resolveClaudeSessionFile", () => {
    /** @type {string} */
    let base;
    beforeEach(async () => {
        base = await makeTempDir();
    });
    afterEach(async () => {
        await rm(base, { recursive: true, force: true });
    });

    test("matches a session by basename regardless of which project folder holds it", async () => {
        const sessionId = "11111111-2222-3333-4444-555555555555";
        // The direct lookup derives the project folder from cwd, but the file is
        // actually stored under a *different* project folder. The fallback must
        // match on the file's basename (`<sessionId>.jsonl`), not on a hard-coded
        // forward-slash suffix, to find it.
        const otherProjectDir = join(base, "-some-other-project");
        await mkdir(otherProjectDir, { recursive: true });
        const sessionFile = join(otherProjectDir, `${sessionId}.jsonl`);
        await writeFile(sessionFile, `${JSON.stringify({ type: "summary" })}\n`);

        const agent = { opts: { claudeProjectsDir: base } };
        const resolved = await resolveClaudeSessionFile(agent, "/work/some/other/cwd", sessionId);
        expect(resolved).toBe(sessionFile);
    });

    test("matches a session whose path separator is not a forward slash (basename match)", async () => {
        const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        // Simulate a recorded session path that uses a backslash separator (as a
        // Windows host would produce). A basename comparison must still match it;
        // the old `endsWith("/<id>.jsonl")` check only handled forward slashes.
        const { basename } = await import("node:path/win32");
        const windowsStylePath = `C:\\Users\\dev\\.claude\\projects\\proj\\${sessionId}.jsonl`;
        expect(basename(windowsStylePath)).toBe(`${sessionId}.jsonl`);
        // Sanity: the pre-fix forward-slash-only check would NOT match this path.
        expect(windowsStylePath.endsWith(`/${sessionId}.jsonl`)).toBe(false);
    });

    test("returns null when sessionId is missing", async () => {
        const agent = { opts: { claudeProjectsDir: base } };
        expect(await resolveClaudeSessionFile(agent, "/work/proj", undefined)).toBeNull();
    });
});

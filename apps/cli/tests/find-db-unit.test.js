import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openSmithersBackend } from "smithers-orchestrator/openSmithersBackend";
import {
    findAndOpenDb,
    findSmithersDb,
    openSmithersDb,
    waitForSmithersDb,
} from "../src/find-db.js";

function tempDir(name) {
    return mkdtempSync(join(tmpdir(), `${name}-`));
}

function withHome(home, fn) {
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
        return fn();
    }
    finally {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
    }
}

describe("find db helpers", () => {
    test("finds smithers.db by walking up directories", () => {
        const root = tempDir("find-db");
        const nested = join(root, "a", "b");
        mkdirSync(nested, { recursive: true });
        const dbPath = join(root, "smithers.db");
        writeFileSync(dbPath, "");
        try {
            expect(findSmithersDb(nested)).toBe(dbPath);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("prefers project anchor db over a closer stray db", () => {
        const root = tempDir("find-db-anchor");
        const nested = join(root, "a", "b");
        mkdirSync(join(root, ".smithers"), { recursive: true });
        mkdirSync(nested, { recursive: true });
        const anchorDb = join(root, "smithers.db");
        writeFileSync(anchorDb, "");
        writeFileSync(join(nested, "smithers.db"), "");
        try {
            withHome(tmpdir(), () => {
                expect(findSmithersDb(nested)).toBe(anchorDb);
            });
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("does not cross a project anchor to use a parent stray db", () => {
        const parent = tempDir("find-db-parent");
        const root = join(parent, "project");
        const nested = join(root, "a", "b");
        mkdirSync(join(root, ".smithers"), { recursive: true });
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(parent, "smithers.db"), "");
        try {
            withHome(tmpdir(), () => {
                expect(() => findSmithersDb(nested)).toThrow(/project anchor/);
            });
        }
        finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    test("warns when multiple smithers.db candidates exist along the walk", () => {
        const root = tempDir("find-db-multiple");
        const nested = join(root, "a", "b");
        mkdirSync(nested, { recursive: true });
        const chosen = join(nested, "smithers.db");
        const ignored = join(root, "smithers.db");
        writeFileSync(chosen, "");
        writeFileSync(ignored, "");
        const originalWrite = process.stderr.write;
        let stderr = "";
        process.stderr.write = (chunk) => {
            stderr += String(chunk);
            return true;
        };
        try {
            expect(findSmithersDb(nested)).toBe(chosen);
            expect(stderr).toContain("[smithers] Warning: multiple smithers.db files");
            expect(stderr).toContain(`Using: ${chosen}`);
            expect(stderr).toContain(`Ignored: ${ignored}`);
        }
        finally {
            process.stderr.write = originalWrite;
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("stops at filesystem root without considering /smithers.db", () => {
        const root = tempDir("find-db-root-guard");
        const nested = join(root, "a", "b");
        mkdirSync(nested, { recursive: true });
        try {
            expect(() => findSmithersDb(nested)).toThrow(/No smithers\.db found/);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("waits for a database file and times out cleanly", async () => {
        const root = tempDir("wait-db");
        try {
            await expect(waitForSmithersDb(root, { timeoutMs: 1, intervalMs: 1 })).rejects.toMatchObject({
                code: "CLI_DB_NOT_FOUND",
            });
            await expect(waitForSmithersDb(Symbol("bad"), { timeoutMs: 1, intervalMs: 1 })).rejects.toBeInstanceOf(TypeError);

            setTimeout(() => {
                writeFileSync(join(root, "smithers.db"), "");
            }, 5);
            expect(await waitForSmithersDb(root, { timeoutMs: 100, intervalMs: 1 })).toBe(join(root, "smithers.db"));
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("opens a sqlite database and returns cleanup handles", async () => {
        const root = tempDir("open-db");
        const dbPath = join(root, "smithers.db");
        try {
            const opened = await openSmithersDb(dbPath);
            expect(opened.adapter).toBeTruthy();
            opened.cleanup();
            opened.cleanup();
            expect(existsSync(dbPath)).toBe(true);

            const found = await findAndOpenDb(root, { timeoutMs: 0 });
            expect(found.dbPath).toBe(dbPath);
            expect(found.choice.backend).toBe("sqlite");
            expect(found.adapter).toBeTruthy();
            found.cleanup();
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("empty default reads do not provision sqlite or pglite stores", async () => {
        const root = tempDir("empty-read");
        mkdirSync(join(root, ".smithers"), { recursive: true });
        try {
            await expect(findAndOpenDb(root, { timeoutMs: 0 })).rejects.toMatchObject({
                code: "CLI_DB_NOT_FOUND",
            });
            expect(existsSync(join(root, "smithers.db"))).toBe(false);
            expect(existsSync(join(root, ".smithers", "pg"))).toBe(false);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("findAndOpenDb reads the resolved pglite backend", async () => {
        const root = tempDir("pglite-read");
        mkdirSync(join(root, ".smithers"), { recursive: true });
        const api = await openSmithersBackend({}, { cwd: root, backend: "pglite", env: {} });
        await api.close?.();
        const previousBackend = process.env.SMITHERS_BACKEND;
        process.env.SMITHERS_BACKEND = "pglite";
        try {
            const found = await findAndOpenDb(root, { timeoutMs: 0 });
            expect(found.choice.backend).toBe("pglite");
            expect(found.dbPath).toBeUndefined();
            expect(found.adapter).toBeTruthy();
            await found.cleanup();
        }
        finally {
            if (previousBackend === undefined) {
                delete process.env.SMITHERS_BACKEND;
            }
            else {
                process.env.SMITHERS_BACKEND = previousBackend;
            }
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("pglite read mode rejects present but uninitialized stores", async () => {
        const root = tempDir("pglite-uninitialized-read");
        mkdirSync(join(root, ".smithers", "pg"), { recursive: true });
        const previousBackend = process.env.SMITHERS_BACKEND;
        process.env.SMITHERS_BACKEND = "pglite";
        try {
            await expect(findAndOpenDb(root, { timeoutMs: 0 })).rejects.toMatchObject({
                code: "CLI_DB_NOT_FOUND",
            });
        }
        finally {
            if (previousBackend === undefined) delete process.env.SMITHERS_BACKEND;
            else process.env.SMITHERS_BACKEND = previousBackend;
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("pglite read mode rejects initialized stores without Smithers run table", async () => {
        const root = tempDir("pglite-no-runs-table");
        mkdirSync(join(root, ".smithers"), { recursive: true });
        const api = await openSmithersBackend({}, { cwd: root, backend: "pglite", env: {} });
        try {
            await api.db.connection.query({ text: "DROP TABLE IF EXISTS _smithers_runs CASCADE" });
        }
        finally {
            await api.close?.();
        }
        const previousBackend = process.env.SMITHERS_BACKEND;
        process.env.SMITHERS_BACKEND = "pglite";
        try {
            await expect(findAndOpenDb(root, { timeoutMs: 0 })).rejects.toMatchObject({
                code: "CLI_DB_NOT_FOUND",
            });
        }
        finally {
            if (previousBackend === undefined) delete process.env.SMITHERS_BACKEND;
            else process.env.SMITHERS_BACKEND = previousBackend;
            rmSync(root, { recursive: true, force: true });
        }
    });
});

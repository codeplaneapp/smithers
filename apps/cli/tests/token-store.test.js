import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTokenScopes, readSmithersTokenStore, smithersTokenStorePath, writeSmithersTokenStore } from "../src/token-store.js";

const originalTokenStore = process.env.SMITHERS_TOKEN_STORE;

afterEach(() => {
    if (originalTokenStore === undefined) {
        delete process.env.SMITHERS_TOKEN_STORE;
    }
    else {
        process.env.SMITHERS_TOKEN_STORE = originalTokenStore;
    }
});

describe("CLI token store helpers", () => {
    test("parses comma and whitespace separated scopes", () => {
        expect(parseTokenScopes("run:read, run:write approval:submit")).toEqual([
            "run:read",
            "run:write",
            "approval:submit",
        ]);
    });

    test("reads and writes token grants at the configured path", () => {
        const dir = mkdtempSync(join(tmpdir(), "smithers-token-store-"));
        try {
            process.env.SMITHERS_TOKEN_STORE = join(dir, "tokens.json");
            writeSmithersTokenStore({
                tokens: {
                    secret: {
                        role: "operator",
                        scopes: ["run:read"],
                    },
                },
            });

            expect(smithersTokenStorePath()).toBe(join(dir, "tokens.json"));
            expect(readSmithersTokenStore().tokens.secret.role).toBe("operator");
            expect(readFileSync(join(dir, "tokens.json"), "utf8")).toContain('"run:read"');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

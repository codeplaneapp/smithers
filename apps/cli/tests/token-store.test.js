import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    issueSmithersBrokerToken,
    parseTokenScopes,
    readSmithersTokenStore,
    resolveSmithersActionToken,
    resolveSmithersActionTokenFromStore,
    revokeSmithersToken,
    smithersTokenStorePath,
    writeSmithersTokenStore,
} from "../src/token-store.js";
import { Gateway } from "../../../packages/server/src/gateway.js";

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
            expect(Object.values(readSmithersTokenStore().tokens)[0].role).toBe("operator");
            expect(readFileSync(join(dir, "tokens.json"), "utf8")).toContain('"run:read"');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("brokers scoped per-action handles without breaking bearer-keyed gateway auth", () => {
        const issued = issueSmithersBrokerToken({
            role: "operator",
            scopes: ["run:read", "approval:submit"],
            userId: "user_123",
            actionId: "approve:run_1",
            ttlMs: 60_000,
            nowMs: 1_000,
            randomBytes: () => Buffer.alloc(32, 7),
        });

        expect(issued.token).toStartWith("smithers_");
        expect(issued.actionToken.handle).toStartWith("smithers_action_");
        expect(JSON.stringify(issued.actionToken)).not.toContain(issued.token);
        expect(issued.store.audit.map((entry) => entry.type)).toEqual(["issued", "action_issued"]);
        expect(issued.store.tokens[issued.token]).toMatchObject({
            tokenId: issued.grant.tokenId,
            role: "operator",
            scopes: ["run:read", "approval:submit"],
        });
        expect(issued.store.tokens[issued.grant.tokenId]).toBeUndefined();

        const resolved = resolveSmithersActionToken(issued.store, issued.actionToken.handle, {
            actionId: "approve:run_1",
            scopes: ["approval:submit"],
            nowMs: 2_000,
        });
        expect(resolved.token).toBe(issued.token);
        expect(resolved.grant.userId).toBe("user_123");
        expect(issued.store.audit.at(-1)).toMatchObject({
            type: "action_used",
            actionId: "approve:run_1",
            tokenId: issued.grant.tokenId,
            atMs: 2_000,
        });

        expect(() => resolveSmithersActionToken(issued.store, issued.actionToken.handle, {
            actionId: "approve:run_1",
            scopes: ["run:write"],
            nowMs: 2_000,
        })).toThrow("scope");

        revokeSmithersToken(issued.store, issued.token, 3_000);
        expect(() => resolveSmithersActionToken(issued.store, issued.actionToken.handle, {
            actionId: "approve:run_1",
            scopes: ["approval:submit"],
            nowMs: 4_000,
        })).toThrow("revoked");
        expect(issued.store.tokens[issued.token].secret).toBe(issued.token);
    });

    test("write preserves operator-authored bearer keys on round trip", () => {
        const dir = mkdtempSync(join(tmpdir(), "smithers-token-store-"));
        try {
            process.env.SMITHERS_TOKEN_STORE = join(dir, "tokens.json");
            writeSmithersTokenStore({
                version: 2,
                tokens: {
                    "replace-me": {
                        role: "operator",
                        scopes: ["run:read"],
                        expiresAtMs: 4_102_444_800_000,
                    },
                },
                actionTokens: {},
                audit: [],
            });

            const raw = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8"));
            expect(raw.tokens["replace-me"]).toMatchObject({ role: "operator" });
            expect(raw.tokens[Object.keys(raw.tokens)[0]].secret).toBeUndefined();
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("read migrates token-id-keyed grants with secrets back to bearer keys", () => {
        const dir = mkdtempSync(join(tmpdir(), "smithers-token-store-"));
        try {
            process.env.SMITHERS_TOKEN_STORE = join(dir, "tokens.json");
            const issued = issueSmithersBrokerToken({
                role: "operator",
                scopes: ["run:read"],
                actionId: "gateway",
                ttlMs: 60_000,
                nowMs: 1_000,
                token: "smithers_old_store_secret",
            });
            writeSmithersTokenStore({
                version: 2,
                tokens: {
                    [issued.grant.tokenId]: issued.grant,
                },
                actionTokens: issued.store.actionTokens,
                audit: issued.store.audit,
            });

            const store = readSmithersTokenStore();
            expect(store.tokens[issued.token]).toMatchObject({ tokenId: issued.grant.tokenId });
            expect(store.tokens[issued.grant.tokenId]).toBeUndefined();
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("resolving an action token from disk persists the use audit", () => {
        const dir = mkdtempSync(join(tmpdir(), "smithers-token-store-"));
        try {
            process.env.SMITHERS_TOKEN_STORE = join(dir, "tokens.json");
            const issued = issueSmithersBrokerToken({
                role: "operator",
                scopes: ["run:read"],
                actionId: "gateway",
                ttlMs: 60_000,
                nowMs: 1_000,
                randomBytes: () => Buffer.alloc(32, 9),
            });
            writeSmithersTokenStore(issued.store);

            const resolved = resolveSmithersActionTokenFromStore(issued.actionToken.handle, {
                actionId: "gateway",
                scopes: ["run:read"],
                nowMs: 2_000,
            });

            expect(resolved.token).toBe(issued.token);
            expect(readSmithersTokenStore().audit.at(-1)).toMatchObject({
                type: "action_used",
                actionId: "gateway",
                tokenId: issued.grant.tokenId,
                atMs: 2_000,
            });
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("issued broker tokens authenticate through the gateway bearer lookup", async () => {
        const issued = issueSmithersBrokerToken({
            role: "operator",
            scopes: ["run:read"],
            actionId: "gateway",
            ttlMs: 60_000,
            nowMs: Date.now(),
            randomBytes: () => Buffer.alloc(32, 11),
        });
        const gateway = new Gateway({
            auth: {
                mode: "token",
                tokens: issued.store.tokens,
            },
        });

        await expect(gateway.authenticateRequest(new Request("http://localhost"), issued.token)).resolves.toMatchObject({
            ok: true,
            role: "operator",
            scopes: ["run:read"],
            tokenId: issued.grant.tokenId,
        });
    });
});

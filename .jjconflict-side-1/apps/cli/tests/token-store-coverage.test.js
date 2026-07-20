import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    mintSmithersActionToken,
    readSmithersTokenStore,
    resolveSmithersActionToken,
    revokeSmithersToken,
} from "../src/token-store.js";

const SECRET = "smithers_secret_abcdef";
function grant(overrides = {}) {
    return { tokenId: "tid-1", secret: SECRET, scopes: ["run:read"], ...overrides };
}
function storeWith(grantOverrides = {}) {
    return { tokens: { [SECRET]: grant(grantOverrides) }, actionTokens: {}, audit: [] };
}

describe("token-store resolve/mint/revoke branches", () => {
    test("mint then resolve exchanges the handle for the backing secret", () => {
        const store = storeWith();
        const at = mintSmithersActionToken(store, { tokenId: "tid-1", actionId: "act-1", scopes: ["run:read"], nowMs: 1000 });
        const resolved = resolveSmithersActionToken(store, at.handle, { actionId: "act-1", scopes: ["run:read"], nowMs: 2000 });
        expect(resolved.token).toBe(SECRET);
    });

    test("rejects unknown handle, action mismatch, revoked/expired handle, and missing grant", () => {
        const store = storeWith();
        const at = mintSmithersActionToken(store, { tokenId: "tid-1", actionId: "act-1", scopes: [], nowMs: 1000 });
        expect(() => resolveSmithersActionToken(store, "nope")).toThrow(/handle was not found/);
        expect(() => resolveSmithersActionToken(store, at.handle, { actionId: "other" })).toThrow(/not valid for this action/);

        store.actionTokens[at.handle].revokedAtMs = 500;
        expect(() => resolveSmithersActionToken(store, at.handle)).toThrow(/handle has been revoked/);
        delete store.actionTokens[at.handle].revokedAtMs;

        store.actionTokens[at.handle].expiresAtMs = 100;
        expect(() => resolveSmithersActionToken(store, at.handle, { nowMs: 200 })).toThrow(/handle has expired/);
        delete store.actionTokens[at.handle].expiresAtMs;

        store.actionTokens[at.handle].tokenId = "no-such-tid";
        expect(() => resolveSmithersActionToken(store, at.handle)).toThrow(/Backing token grant was not found/);
    });

    test("rejects a revoked or expired backing grant", () => {
        const revokedStore = storeWith({ revokedAtMs: 5 });
        const at1 = mintSmithersActionToken(revokedStore, { tokenId: "tid-1", scopes: [], nowMs: 1 });
        expect(() => resolveSmithersActionToken(revokedStore, at1.handle)).toThrow(/grant has been revoked/);

        const expiredStore = storeWith({ expiresAtMs: 10 });
        const at2 = mintSmithersActionToken(expiredStore, { tokenId: "tid-1", scopes: [], nowMs: 1 });
        expect(() => resolveSmithersActionToken(expiredStore, at2.handle, { nowMs: 20 })).toThrow(/grant has expired/);
    });

    test("revoke by tokenId revokes the grant and its action tokens; unknown returns null", () => {
        const store = storeWith();
        const at = mintSmithersActionToken(store, { tokenId: "tid-1", scopes: [], nowMs: 1 });
        const revoked = revokeSmithersToken(store, "tid-1", 999);
        expect(revoked?.revokedAtMs).toBe(999);
        expect(store.actionTokens[at.handle].revokedAtMs).toBe(999);
        expect(revokeSmithersToken(store, "totally-unknown-id")).toBeNull();
    });

    test("trims the audit log past the cap", () => {
        const audit = Array.from({ length: 1000 }, (_, i) => ({ type: "seed", i }));
        const store = { tokens: { [SECRET]: grant() }, actionTokens: {}, audit };
        mintSmithersActionToken(store, { tokenId: "tid-1", scopes: [], nowMs: 1 });
        expect(store.audit.length).toBe(1000);
    });

    test("drops malformed audit entries when normalizing", () => {
        const store = { tokens: {}, actionTokens: {}, audit: [{ type: "ok" }, { bad: true }, null, "nope"] };
        revokeSmithersToken(store, "unknown");
        expect(store.audit.every((e) => e && typeof e.type === "string")).toBe(true);
    });
});

describe("readSmithersTokenStore filesystem fallbacks", () => {
    const original = process.env.SMITHERS_TOKEN_STORE;
    afterEach(() => {
        if (original === undefined) delete process.env.SMITHERS_TOKEN_STORE;
        else process.env.SMITHERS_TOKEN_STORE = original;
    });

    test("returns a default store when the file is missing", () => {
        process.env.SMITHERS_TOKEN_STORE = join(tmpdir(), `no-such-token-store-${Date.now()}.json`);
        expect(readSmithersTokenStore().tokens).toEqual({});
    });

    test("throws on a corrupt file instead of silently returning an empty store, leaving it untouched for recovery", () => {
        const dir = mkdtempSync(join(tmpdir(), "token-corrupt-"));
        try {
            const p = join(dir, "tokens.json");
            const corruptContents = "{not valid json";
            writeFileSync(p, corruptContents);
            process.env.SMITHERS_TOKEN_STORE = p;
            expect(() => readSmithersTokenStore()).toThrow(/corrupt/);
            expect(readFileSync(p, "utf8")).toBe(corruptContents);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/**
 * Persistent store for gateway bearer-token grants and the short-lived
 * action-token handles minted from them. Lives at `~/.smithers/tokens.json`
 * (override with `SMITHERS_TOKEN_STORE`). Token ids are the first 16 hex
 * chars of the token's sha256, so an id is derivable from a presented secret
 * without keeping a reverse map.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { dirname, resolve } from "node:path";

// v2 keys `tokens` by the bearer secret itself (v1 keyed by tokenId);
// normalizeStore upgrades v1-shaped entries on read.
const STORE_VERSION = 2;
// Cap the audit trail so tokens.json cannot grow without bound.
const MAX_AUDIT_ENTRIES = 1_000;

/**
 * @typedef {Object} TokenGrant
 * @property {string} tokenId First 16 hex chars of the secret's sha256.
 * @property {string[]} scopes
 * @property {string} [role]
 * @property {string} [userId]
 * @property {number} [issuedAtMs]
 * @property {number} [expiresAtMs]
 * @property {string} [secret] The bearer secret backing this grant.
 * @property {string} [tokenHash] Full sha256 hex of the secret.
 * @property {number} [revokedAtMs]
 */

/**
 * @typedef {Object} ActionToken
 * @property {string} handle
 * @property {string} tokenId Id of the backing grant.
 * @property {string} actionId
 * @property {string[]} scopes
 * @property {number} issuedAtMs
 * @property {number} [expiresAtMs]
 * @property {number} [revokedAtMs]
 */

/**
 * @typedef {Object} TokenStore
 * @property {number} version
 * @property {Record<string, TokenGrant>} tokens Keyed by bearer secret (v2).
 * @property {Record<string, ActionToken>} actionTokens Keyed by handle.
 * @property {Array<Record<string, any>>} audit Capped trail; every entry has a string `type`.
 */

/** @param {string} token */
function tokenIdFor(token) {
    return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** @param {string} token */
function tokenHashFor(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

/** @returns {TokenStore} */
function defaultStore() {
    return { version: STORE_VERSION, tokens: {}, actionTokens: {}, audit: [] };
}

function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeAuditEntry(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.type !== "string") {
        return null;
    }
    return entry;
}

/**
 * Coerce arbitrary parsed JSON into a well-formed store: re-keys v1 grants by
 * secret where recoverable, backfills tokenId/tokenHash, and drops malformed
 * scopes/audit entries.
 *
 * @param {unknown} parsed
 * @returns {TokenStore}
 */
function normalizeStore(parsed) {
    const store = defaultStore();
    const raw = asRecord(parsed);
    const rawTokens = asRecord(raw.tokens);
    for (const [key, value] of Object.entries(rawTokens)) {
        const grant = asRecord(value);
        const tokenId = typeof grant.tokenId === "string" && grant.tokenId.length > 0 ? grant.tokenId : tokenIdFor(key);
        const secret = typeof grant.secret === "string" ? grant.secret : key.startsWith("smithers_") ? key : undefined;
        const storeKey = secret && key === tokenId ? secret : key;
        store.tokens[storeKey] = {
            ...grant,
            tokenId,
            ...(secret ? { secret, tokenHash: typeof grant.tokenHash === "string" ? grant.tokenHash : tokenHashFor(secret) } : {}),
            scopes: Array.isArray(grant.scopes) ? grant.scopes.filter((scope) => typeof scope === "string") : [],
        };
    }
    store.actionTokens = asRecord(raw.actionTokens);
    store.audit = Array.isArray(raw.audit) ? raw.audit.map(normalizeAuditEntry).filter(Boolean) : [];
    return store;
}

function appendAudit(store, entry) {
    store.audit.push(entry);
    if (store.audit.length > MAX_AUDIT_ENTRIES) {
        store.audit.splice(0, store.audit.length - MAX_AUDIT_ENTRIES);
    }
}

function findTokenEntryById(store, tokenId) {
    for (const [token, grant] of Object.entries(store.tokens)) {
        if (grant?.tokenId === tokenId) {
            return { token, grant };
        }
    }
    return null;
}

function assertScopes(grant, requiredScopes) {
    const granted = new Set(Array.isArray(grant.scopes) ? grant.scopes : []);
    const missing = requiredScopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
        throw new Error(`Token is missing required scope(s): ${missing.join(", ")}`);
    }
}

function assertGrantActive(grant, nowMs) {
    if (typeof grant.revokedAtMs === "number") {
        throw new Error("Token grant has been revoked");
    }
    if (typeof grant.expiresAtMs === "number" && grant.expiresAtMs <= nowMs) {
        throw new Error("Token grant has expired");
    }
}

/**
 * Path of the on-disk store: `SMITHERS_TOKEN_STORE` if set, otherwise
 * `~/.smithers/tokens.json`.
 *
 * @returns {string}
 */
export function smithersTokenStorePath() {
    return process.env.SMITHERS_TOKEN_STORE ?? resolve(process.env.HOME ?? process.cwd(), ".smithers", "tokens.json");
}

/**
 * Load and normalize the on-disk store. A missing or corrupt file yields an
 * empty store rather than an error.
 *
 * @returns {TokenStore}
 */
export function readSmithersTokenStore() {
    const path = smithersTokenStorePath();
    if (!existsSync(path)) {
        return defaultStore();
    }
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return normalizeStore(parsed);
    }
    catch {
        return defaultStore();
    }
}

/**
 * Persist the store (creating parent directories; new files are mode 0600).
 *
 * @param {TokenStore} store
 */
export function writeSmithersTokenStore(store) {
    const path = smithersTokenStorePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Split a comma/whitespace-separated scope list into scope names.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function parseTokenScopes(raw) {
    return raw
        .split(/[,\s]+/)
        .map((scope) => scope.trim())
        .filter(Boolean);
}

/**
 * Issue a new bearer-token grant plus a bootstrap action token bound to it.
 * Mutates `options.store` in place when given (otherwise starts a new store).
 *
 * @param {{
 *   role: string,
 *   ttlMs: number,
 *   scopes?: string[],
 *   userId?: string,
 *   token?: string,
 *   actionId?: string,
 *   nowMs?: number,
 *   store?: TokenStore,
 *   randomBytes?: (size: number) => Buffer,
 * }} options
 * @returns {{ token: string, grant: TokenGrant, actionToken: ActionToken, store: TokenStore }}
 */
export function issueSmithersBrokerToken(options) {
    const nowMs = options.nowMs ?? Date.now();
    const randomBytes = options.randomBytes ?? ((size) => crypto.randomBytes(size));
    const token = options.token ?? `smithers_${randomBytes(32).toString("base64url")}`;
    const tokenId = tokenIdFor(token);
    const grant = {
        tokenId,
        role: options.role,
        scopes: Array.isArray(options.scopes) ? options.scopes : [],
        ...(options.userId ? { userId: options.userId } : {}),
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + options.ttlMs,
        secret: token,
        tokenHash: tokenHashFor(token),
    };
    const store = options.store ?? defaultStore();
    Object.assign(store, normalizeStore(store));
    store.tokens[token] = grant;
    appendAudit(store, {
        type: "issued",
        tokenId,
        role: grant.role,
        scopes: grant.scopes,
        ...(grant.userId ? { userId: grant.userId } : {}),
        atMs: nowMs,
        expiresAtMs: grant.expiresAtMs,
    });
    const actionToken = mintSmithersActionToken(store, {
        tokenId,
        actionId: options.actionId ?? "gateway",
        scopes: grant.scopes,
        nowMs,
        expiresAtMs: grant.expiresAtMs,
        randomBytes,
    });
    return { token, grant, actionToken, store };
}

/**
 * Mint a short-lived action-token handle backed by an existing grant.
 *
 * @param {TokenStore} store Mutated in place (normalized, handle appended).
 * @param {{
 *   tokenId: string,
 *   actionId: string,
 *   scopes?: string[],
 *   handle?: string,
 *   nowMs?: number,
 *   expiresAtMs?: number,
 *   randomBytes?: (size: number) => Buffer,
 * }} options
 * @returns {ActionToken}
 */
export function mintSmithersActionToken(store, options) {
    const normalized = normalizeStore(store);
    Object.assign(store, normalized);
    const handle = options.handle ?? `smithers_action_${(options.randomBytes ?? ((size) => crypto.randomBytes(size)))(24).toString("base64url")}`;
    const actionToken = {
        handle,
        tokenId: options.tokenId,
        actionId: options.actionId,
        scopes: Array.isArray(options.scopes) ? options.scopes : [],
        issuedAtMs: options.nowMs ?? Date.now(),
        expiresAtMs: options.expiresAtMs,
    };
    store.actionTokens[handle] = actionToken;
    appendAudit(store, {
        type: "action_issued",
        tokenId: options.tokenId,
        actionId: options.actionId,
        scopes: actionToken.scopes,
        atMs: actionToken.issuedAtMs,
        expiresAtMs: actionToken.expiresAtMs,
    });
    return actionToken;
}

/**
 * Exchange an action-token handle for its backing bearer secret, enforcing
 * revocation, expiry, action binding, and required scopes on both the handle
 * and the backing grant. Throws on any violation.
 *
 * @param {TokenStore} store Mutated in place (normalized, audit appended).
 * @param {string} handle
 * @param {{ actionId?: string, scopes?: string[], nowMs?: number }} [options]
 * @returns {{ token: string, grant: TokenGrant, actionToken: ActionToken }}
 */
export function resolveSmithersActionToken(store, handle, options = {}) {
    const normalized = normalizeStore(store);
    Object.assign(store, normalized);
    const nowMs = options.nowMs ?? Date.now();
    const actionToken = store.actionTokens[handle];
    if (!actionToken) {
        throw new Error("Action token handle was not found");
    }
    if (options.actionId && actionToken.actionId !== options.actionId) {
        throw new Error("Action token is not valid for this action");
    }
    if (typeof actionToken.revokedAtMs === "number") {
        throw new Error("Action token handle has been revoked");
    }
    if (typeof actionToken.expiresAtMs === "number" && actionToken.expiresAtMs <= nowMs) {
        throw new Error("Action token handle has expired");
    }
    const entry = findTokenEntryById(store, actionToken.tokenId);
    const grant = entry?.grant;
    if (!grant || typeof grant.secret !== "string") {
        throw new Error("Backing token grant was not found");
    }
    assertGrantActive(grant, nowMs);
    const requiredScopes = Array.isArray(options.scopes) ? options.scopes : [];
    assertScopes(actionToken, requiredScopes);
    assertScopes(grant, requiredScopes);
    appendAudit(store, {
        type: "action_used",
        tokenId: actionToken.tokenId,
        actionId: actionToken.actionId,
        scopes: requiredScopes,
        atMs: nowMs,
    });
    return { token: grant.secret, grant, actionToken };
}

/**
 * Like `resolveSmithersActionToken`, but against the on-disk store, persisting
 * the audit trail back to disk on success.
 *
 * @param {string} handle
 * @param {{ actionId?: string, scopes?: string[], nowMs?: number }} [options]
 * @returns {{ token: string, grant: TokenGrant, actionToken: ActionToken }}
 */
export function resolveSmithersActionTokenFromStore(handle, options = {}) {
    const store = readSmithersTokenStore();
    const resolved = resolveSmithersActionToken(store, handle, options);
    writeSmithersTokenStore(store);
    return resolved;
}

/**
 * Revoke a grant (looked up by secret, tokenId, or raw token) plus every
 * action token minted from it.
 *
 * @param {TokenStore} store Mutated in place.
 * @param {string} tokenOrId
 * @param {number} [nowMs]
 * @returns {TokenGrant | null} The revoked grant, or null if nothing matched.
 */
export function revokeSmithersToken(store, tokenOrId, nowMs = Date.now()) {
    const normalized = normalizeStore(store);
    Object.assign(store, normalized);
    const entry = store.tokens[tokenOrId]
        ? { token: tokenOrId, grant: store.tokens[tokenOrId] }
        : findTokenEntryById(store, tokenOrId) ?? findTokenEntryById(store, tokenIdFor(tokenOrId));
    if (!entry?.grant) {
        return null;
    }
    const grant = entry.grant;
    const tokenId = grant.tokenId ?? tokenIdFor(entry.token);
    grant.revokedAtMs = nowMs;
    for (const actionToken of Object.values(store.actionTokens)) {
        if (actionToken.tokenId === tokenId && typeof actionToken.revokedAtMs !== "number") {
            actionToken.revokedAtMs = nowMs;
        }
    }
    appendAudit(store, { type: "revoked", tokenId, atMs: nowMs });
    return grant;
}

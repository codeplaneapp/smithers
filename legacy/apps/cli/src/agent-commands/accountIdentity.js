import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** @typedef {import("@smthrs/accounts").Account} Account */
/** @typedef {{ email?: string; accountId?: string; organizationId?: string }} AccountIdentity */

/**
 * Which subscription a config directory is actually logged into. Registering
 * the same subscription under two labels adds no capacity — it just splits one
 * rate limit across two chain rungs — so `agents add` and `agents list` use
 * this to surface the underlying account.
 *
 * Reads only non-secret identity fields; access/refresh tokens are never
 * returned, logged, or persisted.
 *
 * @param {string | undefined} provider
 * @param {string | undefined} configDir
 * @returns {AccountIdentity | null}
 */
export function readAccountIdentity(provider, configDir) {
  if (!configDir) return null;
  if (provider === "claude-code") return readClaudeIdentity(configDir);
  if (provider === "codex") return readCodexIdentity(configDir);
  return null;
}

/**
 * @param {string} configDir
 * @returns {AccountIdentity | null}
 */
function readClaudeIdentity(configDir) {
  const state = readJson(join(configDir, ".claude.json"));
  const oauth = state?.oauthAccount;
  if (!oauth || typeof oauth !== "object") return null;
  const email = typeof oauth.emailAddress === "string" ? oauth.emailAddress : undefined;
  const accountId = typeof oauth.accountUuid === "string" ? oauth.accountUuid : undefined;
  const organizationId = typeof oauth.organizationUuid === "string" ? oauth.organizationUuid : undefined;
  return email || accountId || organizationId ? { email, accountId, organizationId } : null;
}

/** @returns {AccountIdentity | null} */
export function readDefaultClaudeIdentity() {
  const state = readJson(join(homedir(), ".claude.json"));
  const oauth = state?.oauthAccount;
  if (!oauth || typeof oauth !== "object") return null;
  const email = typeof oauth.emailAddress === "string" ? oauth.emailAddress : undefined;
  const accountId = typeof oauth.accountUuid === "string" ? oauth.accountUuid : undefined;
  const organizationId = typeof oauth.organizationUuid === "string" ? oauth.organizationUuid : undefined;
  return email || accountId || organizationId ? { email, accountId, organizationId } : null;
}

/**
 * @param {string} configDir
 * @returns {AccountIdentity | null}
 */
function readCodexIdentity(configDir) {
  const auth = readJson(join(configDir, "auth.json"));
  const tokens = auth?.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id : undefined;
  const claims = decodeJwtClaims(tokens.id_token);
  const email = typeof claims?.email === "string" ? claims.email : undefined;
  return email || accountId ? { email, accountId } : null;
}

/**
 * @param {string} path
 * @returns {any}
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Decode a JWT's payload without verifying it: the token was just written by
 * the vendor CLI into a file only this user can read, and the claims are used
 * purely to label the account for the human.
 *
 * @param {unknown} token
 * @returns {Record<string, unknown> | null}
 */
function decodeJwtClaims(token) {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Human-readable one-liner for an identity, e.g. `will@tevm.tech`.
 *
 * @param {AccountIdentity | null} identity
 * @returns {string}
 */
export function formatAccountIdentity(identity) {
  if (!identity) return "";
  if (identity.email) return identity.email;
  return identity.accountId ? `account ${identity.accountId.slice(0, 8)}` : "";
}

/**
 * Labels of already-registered accounts that are logged into the SAME
 * subscription as `identity`. Matching prefers the stable account id and falls
 * back to the email, so a renamed account is still recognized.
 *
 * Only same-provider accounts are compared: one person's Claude subscription
 * and ChatGPT subscription commonly share an email address, but they are
 * separate vendors with separate rate limits — reporting them as duplicates
 * would tell the user to delete a seat that adds real capacity.
 *
 * @param {AccountIdentity | null} identity
 * @param {string | undefined} provider
 * @param {Account[]} accounts
 * @param {string} excludeLabel
 * @returns {string[]}
 */
export function findDuplicateAccounts(identity, provider, accounts, excludeLabel) {
  if (!identity || (!identity.organizationId && !identity.accountId && !identity.email)) return [];
  const duplicates = [];
  for (const account of accounts) {
    if (account.label === excludeLabel || account.provider !== provider) continue;
    const other = readAccountIdentity(account.provider, account.configDir);
    if (!other) continue;
    const sameSubscription =
      identity.organizationId && other.organizationId
        ? identity.organizationId === other.organizationId
        : identity.accountId && other.accountId
          ? identity.accountId === other.accountId
          : Boolean(identity.email && other.email && identity.email === other.email);
    if (sameSubscription) duplicates.push(account.label);
  }
  return duplicates;
}

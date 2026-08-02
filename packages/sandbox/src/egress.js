import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SmithersError } from "@smthrs/errors/SmithersError";

export const SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH = ".smithers/egress/ca.crt";
export const SANDBOX_EGRESS_CA_WORKSPACE_PATH = "/workspace/.smithers/egress/ca.crt";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_EGRESS_STRING_LENGTH = 64 * 1024;

/**
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
function invalidEgressConfig(message, details = {}) {
  throw new SmithersError("INVALID_INPUT", message, details);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string | undefined}
 */
function optionalString(value, field) {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EGRESS_STRING_LENGTH ||
    value.includes("\0")
  ) {
    invalidEgressConfig(`${field} must be a non-empty string within supported bounds.`, { field });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{ envKeys?: boolean }} [options]
 * @returns {Record<string, string> | undefined}
 */
function optionalStringRecord(value, field, options = {}) {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    invalidEgressConfig(`${field} must be a flat object of string values.`, { field });
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (options.envKeys !== false && !ENV_NAME_RE.test(key)) {
      invalidEgressConfig(`${field} keys must be valid environment variable names.`, { field, key });
    }
    if (key.length === 0 || key.length > 512 || key.includes("\0")) {
      invalidEgressConfig(`${field} keys must be strings within supported bounds.`, { field, key });
    }
    if (typeof entryValue !== "string" || entryValue.length > MAX_EGRESS_STRING_LENGTH || entryValue.includes("\0")) {
      invalidEgressConfig(`${field} values must be strings within supported bounds.`, { field, key });
    }
    out[key] = entryValue;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeNoProxy(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return optionalString(value, "egress.noProxy");
  }
  if (!Array.isArray(value)) {
    invalidEgressConfig("egress.noProxy must be a string or string array.", { field: "egress.noProxy" });
  }
  return value.map((entry, index) => optionalString(entry, `egress.noProxy[${index}]`)).join(",");
}

/**
 * @param {unknown} value
 * @returns {import("./SandboxEgressConfig.ts").SandboxEgressConfig | undefined}
 */
export function normalizeSandboxEgressConfig(value) {
  if (value === undefined || value === null || value === false) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    invalidEgressConfig("Sandbox egress must be an object.");
  }
  const env = optionalStringRecord(value.env, "egress.env");
  const httpProxy = optionalString(value.httpProxy, "egress.httpProxy");
  const httpsProxy = optionalString(value.httpsProxy, "egress.httpsProxy");
  const noProxy = normalizeNoProxy(value.noProxy);
  const caCertPem = optionalString(value.caCertPem, "egress.caCertPem");
  const caCertPath = optionalString(value.caCertPath, "egress.caCertPath");
  const secretBindings = optionalStringRecord(value.secretBindings, "egress.secretBindings", { envKeys: false });
  if (caCertPem && caCertPath) {
    invalidEgressConfig("Sandbox egress must use either caCertPem or caCertPath, not both.");
  }
  /** @type {import("./SandboxEgressConfig.ts").SandboxEgressConfig} */
  const normalized = {};
  if (env && Object.keys(env).length > 0) normalized.env = env;
  if (httpProxy) normalized.httpProxy = httpProxy;
  if (httpsProxy) normalized.httpsProxy = httpsProxy;
  if (noProxy) normalized.noProxy = noProxy;
  if (caCertPem) normalized.caCertPem = caCertPem;
  if (caCertPath) normalized.caCertPath = caCertPath;
  if (secretBindings && Object.keys(secretBindings).length > 0) normalized.secretBindings = secretBindings;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * @param {unknown} value
 * @param {{ caCertPath?: string }} [options]
 * @returns {Record<string, string>}
 */
export function sandboxEgressEnv(value, options = {}) {
  const egress = normalizeSandboxEgressConfig(value);
  if (!egress) {
    return {};
  }
  const env = { ...egress.env };
  if (egress.httpProxy) {
    env.HTTP_PROXY = egress.httpProxy;
  }
  if (egress.httpsProxy) {
    env.HTTPS_PROXY = egress.httpsProxy;
  }
  if (egress.noProxy) {
    env.NO_PROXY = Array.isArray(egress.noProxy) ? egress.noProxy.join(",") : egress.noProxy;
  }
  const caCertPath =
    egress.caCertPath ?? (egress.caCertPem ? (options.caCertPath ?? SANDBOX_EGRESS_CA_WORKSPACE_PATH) : undefined);
  if (caCertPath) {
    env.NODE_EXTRA_CA_CERTS = caCertPath;
  }
  return env;
}

/**
 * @param {unknown} value
 * @param {string} requestBundlePath
 * @returns {Promise<void>}
 */
export async function writeSandboxEgressFiles(value, requestBundlePath) {
  const egress = normalizeSandboxEgressConfig(value);
  if (!egress?.caCertPem) {
    return;
  }
  const caPath = join(requestBundlePath, SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH);
  await mkdir(dirname(caPath), { recursive: true });
  await writeFile(caPath, egress.caCertPem, { encoding: "utf8", mode: 0o600 });
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactSandboxEgressConfig(value) {
  const egress = normalizeSandboxEgressConfig(value);
  if (!egress) {
    return value;
  }
  /** @type {Record<string, unknown>} */
  const redacted = {};
  // Env redaction keeps the key names and hides only the values.
  if (egress.env)
    redacted.env = Object.fromEntries(
      Object.keys(egress.env)
        .sort()
        .map((key) => [key, "[redacted]"]),
    );
  if (egress.httpProxy) redacted.httpProxy = "[redacted]";
  if (egress.httpsProxy) redacted.httpsProxy = "[redacted]";
  if (egress.noProxy) redacted.noProxy = "[redacted]";
  if (egress.caCertPem) redacted.caCertPem = "[redacted]";
  if (egress.caCertPath) redacted.caCertPath = "[redacted]";
  // Secret binding NAMES are sensitive too, so only the count may leak.
  if (egress.secretBindings)
    redacted.secretBindings = Object.fromEntries(
      Object.keys(egress.secretBindings)
        .sort()
        .map((_, index) => [`binding_${index + 1}`, "[redacted]"]),
    );
  return redacted;
}

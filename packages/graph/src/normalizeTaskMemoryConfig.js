import { SmithersError } from "@smthrs/errors/SmithersError";

const MEMORY_NAMESPACE_KINDS = new Set(["workflow", "agent", "user", "global"]);

/** @param {string} message */
function invalidMemory(message) {
  return new SmithersError("INVALID_INPUT", `Memory ${message}`);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidMemory(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{ nonEmpty?: boolean }} [options]
 * @returns {string[]}
 */
function stringArray(value, field, options = {}) {
  if (!Array.isArray(value)) {
    throw invalidMemory(`${field} must be an array of non-empty strings.`);
  }
  const normalized = value.map((entry) => nonEmptyString(entry, `${field} entries`));
  if (options.nonEmpty && normalized.length === 0) {
    throw invalidMemory(`${field} must contain at least one entry.`);
  }
  return [...new Set(normalized)];
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string | import("./types.ts").MemoryNamespace}
 */
function memoryNamespace(value, field) {
  if (typeof value === "string") {
    return nonEmptyString(value, field);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidMemory(`${field} must be a namespace string or { kind, id } object.`);
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (typeof raw.kind !== "string" || !MEMORY_NAMESPACE_KINDS.has(raw.kind)) {
    throw invalidMemory(`${field}.kind must be workflow, agent, user, or global.`);
  }
  return {
    kind: /** @type {import("./types.ts").MemoryNamespaceKind} */ (raw.kind),
    id: nonEmptyString(raw.id, `${field}.id`),
  };
}

/** @param {Record<string, unknown>} raw @param {string} key */
function has(raw, key) {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

/**
 * Validate and normalize every source of TaskDescriptor.memoryConfig.
 * Bank-based configurations receive the component defaults. Legacy-only
 * metadata remains accepted and preserved without activating runtime memory.
 *
 * @param {unknown} value
 * @returns {import("./types.ts").TaskMemoryConfig | undefined}
 */
export function normalizeTaskMemoryConfig(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidMemory("configuration must be an object.");
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  const normalized = { ...raw };

  if (has(raw, "namespace")) {
    normalized.namespace = memoryNamespace(raw.namespace, "namespace");
  }
  if (has(raw, "remember")) {
    if (!raw.remember || typeof raw.remember !== "object" || Array.isArray(raw.remember)) {
      throw invalidMemory("remember must be an object.");
    }
    const remember = /** @type {Record<string, unknown>} */ (raw.remember);
    normalized.remember = {
      ...(has(remember, "namespace") ? { namespace: memoryNamespace(remember.namespace, "remember.namespace") } : {}),
      ...(has(remember, "key") ? { key: nonEmptyString(remember.key, "remember.key") } : {}),
    };
  }
  if (has(raw, "threadId")) {
    normalized.threadId = nonEmptyString(raw.threadId, "threadId");
  }

  const hasBank = has(raw, "bank");
  const hasBanks = has(raw, "banks");
  if (hasBank && hasBanks) {
    throw invalidMemory("accepts either bank or banks, not both.");
  }
  if (hasBank) {
    normalized.bank = nonEmptyString(raw.bank, "bank");
  }
  if (hasBanks) {
    normalized.banks = stringArray(raw.banks, "banks", { nonEmpty: true });
  }

  let legacyRecall = false;
  if (has(raw, "recall") && raw.recall && typeof raw.recall === "object" && !Array.isArray(raw.recall)) {
    legacyRecall = true;
    const recall = /** @type {Record<string, unknown>} */ (raw.recall);
    normalized.recall = {
      ...(has(recall, "namespace") ? { namespace: memoryNamespace(recall.namespace, "recall.namespace") } : {}),
      ...(has(recall, "query") ? { query: nonEmptyString(recall.query, "recall.query") } : {}),
      ...(has(recall, "topK")
        ? (() => {
            if (!Number.isSafeInteger(recall.topK) || Number(recall.topK) <= 0) {
              throw invalidMemory("recall.topK must be a positive safe integer.");
            }
            return { topK: recall.topK };
          })()
        : {}),
    };
  } else if (has(raw, "recall")) {
    const recall = raw.recall;
    if (recall !== false && recall !== "auto" && (typeof recall !== "string" || recall.trim().length === 0)) {
      throw invalidMemory("recall must be auto, a non-empty query string, or false.");
    }
    normalized.recall = typeof recall === "string" ? recall.trim() : recall;
  }

  if (has(raw, "tags")) {
    normalized.tags = stringArray(raw.tags, "tags");
  }
  if (has(raw, "primers")) {
    normalized.primers = stringArray(raw.primers, "primers");
  }
  if (has(raw, "budget") && raw.budget !== "low" && raw.budget !== "mid" && raw.budget !== "high") {
    throw invalidMemory("budget must be low, mid, or high.");
  }
  if (has(raw, "maxTokens") && (!Number.isSafeInteger(raw.maxTokens) || Number(raw.maxTokens) <= 0)) {
    throw invalidMemory("maxTokens must be a positive safe integer.");
  }
  if (has(raw, "retain") && raw.retain !== "on-complete" && raw.retain !== "off") {
    throw invalidMemory("retain must be on-complete or off.");
  }
  if (has(raw, "tools") && typeof raw.tools !== "boolean") {
    throw invalidMemory("tools must be a boolean.");
  }

  const modernWithoutBank =
    has(raw, "tags") ||
    has(raw, "budget") ||
    has(raw, "maxTokens") ||
    has(raw, "primers") ||
    has(raw, "retain") ||
    has(raw, "tools") ||
    (has(raw, "recall") && !legacyRecall);
  if (!hasBank && !hasBanks) {
    if (modernWithoutBank) {
      throw invalidMemory("requires bank or banks for bank-based fields.");
    }
    return /** @type {import("./types.ts").TaskMemoryConfig} */ (normalized);
  }

  return /** @type {import("./types.ts").TaskMemoryConfig} */ ({
    ...normalized,
    tags: normalized.tags ?? [],
    recall: has(raw, "recall") ? normalized.recall : "auto",
    budget: normalized.budget ?? "mid",
    maxTokens: normalized.maxTokens ?? 2048,
    primers: normalized.primers ?? [],
    retain: normalized.retain ?? "off",
    tools: normalized.tools ?? false,
  });
}

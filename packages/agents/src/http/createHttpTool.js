import { dynamicTool } from "ai";
import { z } from "zod";

/** @typedef {import("ai").Tool} Tool */
/** @typedef {import("./CreateHttpToolOptions.ts").CreateHttpToolOptions} CreateHttpToolOptions */
/** @typedef {import("./HttpToolInput.ts").HttpToolInput} HttpToolInput */
/** @typedef {import("./HttpToolOutput.ts").HttpToolOutput} HttpToolOutput */

const httpToolInputSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional().default("GET"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()])).optional(),
  body: z.unknown().optional(),
  auth: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("bearer"), token: z.string() }),
      z.object({ type: z.literal("basic"), username: z.string(), password: z.string() }),
      z.object({ type: z.literal("header"), name: z.string(), value: z.string() }),
    ])
    .optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * Create an AI SDK tool that can call any REST API without an OpenAPI spec.
 *
 * @param {CreateHttpToolOptions} [options]
 * @returns {Tool}
 */
export function createHttpTool(options = {}) {
  return dynamicTool({
    description:
      options.description ??
      "Call any REST API by providing method, url, headers, query params, body, and optional auth.",
    inputSchema: httpToolInputSchema,
    execute: async (input) => executeHttpRequest(/** @type {HttpToolInput} */ (input), options),
  });
}

/**
 * @param {HttpToolInput} input
 * @param {CreateHttpToolOptions} options
 * @returns {Promise<HttpToolOutput>}
 */
async function executeHttpRequest(input, options) {
  const url = new URL(input.url);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = new Headers(options.defaultHeaders ?? {});
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    headers.set(key, value);
  }
  applyAuth(headers, input.auth);

  const init = /** @type {RequestInit} */ ({
    method: input.method ?? "GET",
    headers,
  });
  if (input.body !== undefined && init.method !== "GET" && init.method !== "HEAD") {
    init.body = serializeBody(input.body, headers);
  }

  const controller = input.timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), input.timeoutMs) : null;
  if (controller) {
    init.signal = controller.signal;
  }
  try {
    const response = await fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: await parseResponseBody(response),
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * @param {Headers} headers
 * @param {HttpToolInput["auth"]} auth
 */
function applyAuth(headers, auth) {
  if (!auth) return;
  if (auth.type === "bearer") {
    headers.set("authorization", `Bearer ${auth.token}`);
  } else if (auth.type === "basic") {
    headers.set("authorization", `Basic ${btoa(`${auth.username}:${auth.password}`)}`);
  } else {
    headers.set(auth.name, auth.value);
  }
}

/**
 * @param {unknown} body
 * @param {Headers} headers
 * @returns {BodyInit}
 */
function serializeBody(body, headers) {
  if (typeof body === "string" || body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams) {
    return body;
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return JSON.stringify(body);
}

/**
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function parseResponseBody(response) {
  if (response.status === 204 || response.status === 205) {
    return null;
  }
  const text = await response.text();
  if (!text) {
    return null;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }
  return text;
}

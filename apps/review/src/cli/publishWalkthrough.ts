import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertHttpUrl,
  readResponseJson,
  readResponseText,
} from "@smithers-orchestrator/http-client";

export const MAX_WALKTHROUGH_BYTES = 25 * 1024 * 1024;
const MAX_PUBLISH_RESPONSE_BYTES = 8 * 1024;
const MAX_PUBLISH_ERROR_BYTES = 1_024;
const MAX_PUBLISH_TOKEN_CHARS = 8_192;
const WALKTHROUGH_ID = /^[a-z0-5]{12}$/;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Obj
    : null;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function assertPublishToken(token: string): void {
  if (
    token.length === 0 || token.length > MAX_PUBLISH_TOKEN_CHARS
    || /[\u0000\r\n]/.test(token)
  ) throw new Error("publish token is empty, oversized, or contains control bytes");
}

export function walkthroughPublishEndpoint(
  value: string,
  options: { expectedOrigin?: string; allowHttpLoopback?: boolean } = {},
): URL {
  const base = assertHttpUrl(value);
  if (base.search || base.hash) throw new Error("publish URL must not include a query or fragment");
  if (
    base.protocol !== "https:"
    && !(options.allowHttpLoopback === true && base.protocol === "http:" && isLoopbackHost(base.hostname))
  ) throw new Error("publish URL must use HTTPS");
  if (options.expectedOrigin && base.origin !== options.expectedOrigin) {
    throw new Error("publish URL must use the configured review service origin");
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  base.pathname = `${prefix}/api/walkthroughs`;
  return base;
}

export function validateWalkthroughPublishResponse(value: unknown): string {
  const response = obj(value);
  if (!response || Object.keys(response).some((key) => key !== "id" && key !== "url")) {
    throw new Error("publish failed: response schema is invalid");
  }
  const id = response.id;
  if (typeof id !== "string" || !WALKTHROUGH_ID.test(id)) {
    throw new Error("publish failed: response had an invalid walkthrough id");
  }
  if (typeof response.url !== "string") throw new Error("publish failed: response had no url");
  const shareUrl = assertHttpUrl(response.url);
  if (
    shareUrl.protocol !== "https:" || shareUrl.pathname !== `/w/${id}`
    || shareUrl.search || shareUrl.hash
  ) throw new Error("publish failed: response url is not a canonical HTTPS walkthrough URL");
  return shareUrl.toString();
}

/** Read one immutable regular-file snapshot without following a final symlink. */
export function readWalkthroughFile(htmlPath: string): Buffer {
  const fd = openSync(htmlPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("walkthrough is not a regular file");
    if (before.size === 0) throw new Error("walkthrough is empty");
    if (before.size > MAX_WALKTHROUGH_BYTES) throw new Error("walkthrough exceeds 25 MB publish limit");
    const html = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      html.byteLength !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev
    ) throw new Error("walkthrough changed while it was being read");
    return html;
  } finally {
    closeSync(fd);
  }
}

export async function uploadWalkthrough(
  html: Uint8Array,
  publishUrl: string,
  token: string,
  options: { expectedOrigin?: string; allowHttpLoopback?: boolean; fetch?: typeof globalThis.fetch } = {},
): Promise<string> {
  if (html.byteLength === 0) throw new Error("walkthrough is empty");
  if (html.byteLength > MAX_WALKTHROUGH_BYTES) throw new Error("walkthrough exceeds 25 MB publish limit");
  assertPublishToken(token);
  const endpoint = walkthroughPublishEndpoint(publishUrl, options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("walkthrough publish timed out")), 30_000);
  let response: Response;
  try {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    // This is the single intentional walkthrough-file egress point. The bytes,
    // credential, HTTPS destination, redirect policy, and response are all
    // bounded and validated immediately above/below this call.
    // codeql[js/file-access-to-http]
    response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/html; charset=utf-8",
      },
      body: html,
    });
    if (!response.ok) {
      const detail = await readResponseText(response, {
        maxBytes: MAX_PUBLISH_ERROR_BYTES,
        signal: controller.signal,
      }).catch(() => "");
      throw new Error(`publish failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
    }
    const data = await readResponseJson(response, {
      maxBytes: MAX_PUBLISH_RESPONSE_BYTES,
      signal: controller.signal,
    });
    return validateWalkthroughPublishResponse(data);
  } finally {
    clearTimeout(timeout);
  }
}

function loadPublishConfig(homeDir = homedir()): { url: string; token: string } {
  let url = process.env.SMITHERS_REVIEW_PUBLISH_URL?.trim() || "";
  let token = process.env.SMITHERS_REVIEW_PUBLISH_TOKEN?.trim() || "";
  if (!url || !token) {
    const path = join(homeDir, ".smithers-review.json");
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { publishUrl?: string; publishToken?: string };
      url = url || raw.publishUrl?.trim() || "";
      token = token || raw.publishToken?.trim() || "";
    }
  }
  if (!url) {
    throw new Error(
      "no publish URL: set SMITHERS_REVIEW_PUBLISH_URL or write ~/.smithers-review.json with { \"publishUrl\": \"...\" }",
    );
  }
  if (!token) {
    throw new Error(
      "no publish token: set SMITHERS_REVIEW_PUBLISH_TOKEN or write ~/.smithers-review.json with { \"publishToken\": \"...\" }",
    );
  }
  return { url, token };
}

/** Upload a walkthrough HTML file to the publish service; returns the share URL. */
export async function publishWalkthrough(htmlPath: string, options: { homeDir?: string } = {}): Promise<string> {
  const { url, token } = loadPublishConfig(options.homeDir);
  return uploadWalkthrough(readWalkthroughFile(htmlPath), url, token, { allowHttpLoopback: true });
}

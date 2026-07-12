import {
  closeSync,
  constants,
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
const MAX_PUBLISH_CONFIG_BYTES = 16 * 1024;
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
    || /[^\x21-\x7e]/.test(token)
  ) throw new Error("publish token is empty, oversized, or contains control bytes");
}

function safePublishDetail(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/@(?!\u200b)/g, "@\u200b")
    .slice(0, 200);
}

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("walkthrough publish timed out"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("walkthrough publish timed out"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export function walkthroughPublishEndpoint(
  value: string,
  options: { expectedOrigin?: string; allowHttpLoopback?: boolean } = {},
): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) throw new Error("publish URL is invalid or oversized");
  const base = assertHttpUrl(value);
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("publish URL must not include credentials, a query, or a fragment");
  }
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

function normalizedShareOrigin(
  value: string,
  options: { allowHttpLoopback?: boolean } = {},
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) throw new Error("share origin is invalid or oversized");
  const url = assertHttpUrl(value);
  if (
    url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")
    || (url.protocol !== "https:"
      && !(options.allowHttpLoopback === true && url.protocol === "http:" && isLoopbackHost(url.hostname)))
  ) throw new Error("share origin must be a credential-free HTTPS origin");
  return url.origin;
}

export function validateWalkthroughPublishResponse(value: unknown, expectedShareOrigin: string): string {
  const response = obj(value);
  if (!response || Object.keys(response).some((key) => key !== "id" && key !== "url")) {
    throw new Error("publish failed: response schema is invalid");
  }
  const id = response.id;
  if (typeof id !== "string" || !WALKTHROUGH_ID.test(id)) {
    throw new Error("publish failed: response had an invalid walkthrough id");
  }
  if (typeof response.url !== "string") throw new Error("publish failed: response had no url");
  const canonicalExpectedOrigin = normalizedShareOrigin(expectedShareOrigin, { allowHttpLoopback: true });
  const shareUrl = assertHttpUrl(response.url);
  if (
    (shareUrl.protocol !== "https:" && !(shareUrl.protocol === "http:" && isLoopbackHost(shareUrl.hostname)))
    || shareUrl.username || shareUrl.password
    || shareUrl.origin !== canonicalExpectedOrigin || shareUrl.pathname !== `/w/${id}`
    || shareUrl.search || shareUrl.hash
  ) throw new Error("publish failed: response url is not a canonical HTTPS walkthrough URL");
  return shareUrl.toString();
}

/** Read one immutable regular-file snapshot without following a final symlink. */
export function readWalkthroughFile(htmlPath: string): Buffer {
  const fd = openSync(htmlPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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

export interface AuthorizedWalkthroughUpload {
  readonly endpoint: URL;
  readonly token: string;
  readonly body: Uint8Array<ArrayBuffer>;
  readonly shareOrigin: string;
}

/** Bind one validated byte snapshot and credential to fixed request/share origins. */
export function authorizeWalkthroughUpload(
  html: Uint8Array,
  publishUrl: string,
  token: string,
  options: { expectedOrigin?: string; expectedShareOrigin?: string; allowHttpLoopback?: boolean } = {},
): AuthorizedWalkthroughUpload {
  if (html.byteLength === 0) throw new Error("walkthrough is empty");
  if (html.byteLength > MAX_WALKTHROUGH_BYTES) throw new Error("walkthrough exceeds 25 MB publish limit");
  assertPublishToken(token);
  // Copy into an ArrayBuffer-backed view so every workspace Fetch type agrees
  // on the request-body contract, even when the caller supplied a Buffer or a
  // view backed by a SharedArrayBuffer.
  const endpoint = walkthroughPublishEndpoint(publishUrl, options);
  const shareOrigin = normalizedShareOrigin(options.expectedShareOrigin ?? endpoint.origin, options);
  const body = new Uint8Array(new ArrayBuffer(html.byteLength));
  body.set(html);
  return {
    endpoint,
    token,
    body,
    shareOrigin,
  };
}

export async function uploadWalkthrough(
  html: Uint8Array,
  publishUrl: string,
  token: string,
  options: {
    expectedOrigin?: string;
    expectedShareOrigin?: string;
    allowHttpLoopback?: boolean;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const authorized = authorizeWalkthroughUpload(html, publishUrl, token, options);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("walkthrough publish timeout is invalid");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("walkthrough publish timed out")), timeoutMs);
  let response: Response;
  try {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    response = await abortable(fetchImpl(authorized.endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${authorized.token}`,
        "content-type": "text/html; charset=utf-8",
      },
      body: authorized.body,
    }), controller.signal);
    if (!response.ok) {
      const detail = await readResponseText(response, {
        maxBytes: MAX_PUBLISH_ERROR_BYTES,
        signal: controller.signal,
      }).catch(() => "");
      throw new Error(`publish failed: HTTP ${response.status}${detail ? ` ${safePublishDetail(detail)}` : ""}`);
    }
    const data = await readResponseJson(response, {
      maxBytes: MAX_PUBLISH_RESPONSE_BYTES,
      signal: controller.signal,
    });
    return validateWalkthroughPublishResponse(data, authorized.shareOrigin);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("publish failed:")) throw error;
    throw new Error(`publish failed: ${safePublishDetail(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export interface PublishTarget {
  url: string;
  token: string;
  shareOrigin: string;
}

function readPublishConfigFile(path: string): unknown {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("publish config is not a regular file");
    if (before.size === 0 || before.size > MAX_PUBLISH_CONFIG_BYTES) {
      throw new Error("publish config is empty or exceeds 16 KB");
    }
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      if ((uid !== undefined && before.uid !== uid) || (before.mode & 0o077) !== 0) {
        throw new Error("publish config must be owned by the current user and private (mode 0600 or stricter)");
      }
    }
    const contents = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      contents.byteLength !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev
    ) throw new Error("publish config changed while it was being read");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(contents); }
    catch { throw new Error("publish config is not valid UTF-8"); }
    return JSON.parse(text) as unknown;
  } finally {
    closeSync(fd);
  }
}

export function loadPublishConfig(
  homeDir = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): PublishTarget {
  const envUrl = env.SMITHERS_REVIEW_PUBLISH_URL?.trim() || "";
  const envToken = env.SMITHERS_REVIEW_PUBLISH_TOKEN?.trim() || "";
  if (Boolean(envUrl) !== Boolean(envToken)) {
    throw new Error("SMITHERS_REVIEW_PUBLISH_URL and SMITHERS_REVIEW_PUBLISH_TOKEN must be set together");
  }

  let url = envUrl;
  let token = envToken;
  let shareOrigin = env.SMITHERS_REVIEW_SHARE_ORIGIN?.trim() || "";
  if (!url) {
    const value = readPublishConfigFile(join(homeDir, ".smithers-review.json"));
    const config = obj(value);
    const allowed = new Set(["publishUrl", "publishToken", "shareOrigin"]);
    if (!config) {
      throw new Error(
        "no publish URL/token: set both publish environment variables or create a private ~/.smithers-review.json",
      );
    }
    if (Object.keys(config).some((key) => !allowed.has(key))) {
      throw new Error("publish config contains unknown fields");
    }
    if (typeof config.publishUrl !== "string" || typeof config.publishToken !== "string") {
      throw new Error("publish config must contain string publishUrl and publishToken fields");
    }
    if (config.shareOrigin !== undefined && typeof config.shareOrigin !== "string") {
      throw new Error("publish config shareOrigin must be a string");
    }
    url = config.publishUrl.trim();
    token = config.publishToken.trim();
    shareOrigin = config.shareOrigin?.trim() || "";
  }

  assertPublishToken(token);
  const endpoint = walkthroughPublishEndpoint(url, { allowHttpLoopback: true });
  return {
    url,
    token,
    shareOrigin: normalizedShareOrigin(shareOrigin || endpoint.origin, { allowHttpLoopback: true }),
  };
}

/** Upload a walkthrough HTML file to the publish service; returns the share URL. */
export async function publishWalkthrough(htmlPath: string, options: { homeDir?: string } = {}): Promise<string> {
  const { url, token, shareOrigin } = loadPublishConfig(options.homeDir);
  return uploadWalkthrough(readWalkthroughFile(htmlPath), url, token, {
    allowHttpLoopback: true,
    expectedShareOrigin: shareOrigin,
  });
}

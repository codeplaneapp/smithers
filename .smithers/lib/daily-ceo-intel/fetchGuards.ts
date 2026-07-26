import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

const IPV4_BLOCKED_RANGES: Array<[number, number]> = [
  [ipv4ToInt("0.0.0.0"), ipv4ToInt("0.255.255.255")],
  [ipv4ToInt("10.0.0.0"), ipv4ToInt("10.255.255.255")],
  [ipv4ToInt("100.64.0.0"), ipv4ToInt("100.127.255.255")],
  [ipv4ToInt("127.0.0.0"), ipv4ToInt("127.255.255.255")],
  [ipv4ToInt("169.254.0.0"), ipv4ToInt("169.254.255.255")],
  [ipv4ToInt("172.16.0.0"), ipv4ToInt("172.31.255.255")],
  [ipv4ToInt("192.0.0.0"), ipv4ToInt("192.0.0.255")],
  [ipv4ToInt("192.168.0.0"), ipv4ToInt("192.168.255.255")],
  [ipv4ToInt("198.18.0.0"), ipv4ToInt("198.19.255.255")],
  [ipv4ToInt("224.0.0.0"), ipv4ToInt("255.255.255.255")],
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return IPV4_BLOCKED_RANGES.some(([start, end]) => value >= start && value <= end);
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7 unique local
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  )
    return true; // fe80::/10 link local
  if (normalized.startsWith("::ffff:")) return isBlockedIpv4(normalized.slice("::ffff:".length));
  return false;
}

// NOTE: this resolves `hostname` via dns.lookup() as a point-in-time check;
// the subsequent fetch() performs its own independent DNS resolution, so a
// DNS-rebinding attacker who changes the record between the two lookups could
// still reach a private address. Fully closing this in JS fetch requires
// pinning the resolved address via a custom dispatcher/agent; not done here.
async function assertPublicHostname(hostname: string): Promise<void> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal")) {
    throw new Error(`Refusing to fetch blocked hostname: ${hostname}`);
  }
  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0) throw new Error(`Could not resolve hostname: ${hostname}`);
  for (const { address, family } of addresses) {
    const blocked =
      family === 4 || isIPv4(address) ? isBlockedIpv4(address) : isIPv6(address) ? isBlockedIpv6(address) : true;
    if (blocked) throw new Error(`Refusing to fetch blocked/private address ${address} for hostname ${hostname}`);
  }
}

export type GuardedFetchOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  allowedContentType?: RegExp;
  maxRedirects?: number;
};

export type GuardedFetchResult = {
  text: string;
  contentType: string | null;
  status: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_MAX_REDIRECTS = 5;

async function assertGuardedUrl(url: string): Promise<URL> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`Refusing non-https URL: ${url}`);
  await assertPublicHostname(parsed.hostname);
  return parsed;
}

async function readBoundedBody(response: Response, maxBytes: number, url: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`Response exceeded ${maxBytes} bytes: ${url}`);
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeded ${maxBytes} bytes: ${url}`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * https-only, SSRF-blocked (private/loopback/link-local ranges), timed out, and
 * size-capped GET. Redirects are followed manually, one hop at a time, so every
 * hop — not just the initial URL — re-passes the https-only and SSRF checks;
 * `fetch`'s built-in `redirect: "follow"` would resolve+connect to attacker-
 * controlled hop targets before this module ever saw the URL.
 */
export async function guardedFetch(url: string, opts: GuardedFetchOptions = {}): Promise<GuardedFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    const parsed = await assertGuardedUrl(currentUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        headers: opts.headers,
        signal: controller.signal,
        redirect: "manual",
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      if (hop >= maxRedirects) throw new Error(`Exceeded ${maxRedirects} redirects fetching ${url}`);
      const location = response.headers.get("location")!;
      currentUrl = new URL(location, parsed).toString();
      continue;
    }

    const contentType = response.headers.get("content-type");
    if (opts.allowedContentType && contentType && !opts.allowedContentType.test(contentType)) {
      throw new Error(`Unexpected content-type "${contentType}" for ${currentUrl}`);
    }
    const text = await readBoundedBody(response, maxBytes, currentUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${currentUrl}`);
    return { text, contentType, status: response.status };
  }
}

/** Exactly one bounded in-function retry on a transient failure. */
export async function withOneRetry<T>(fn: () => Promise<T>): Promise<{ result: T; retried: boolean }> {
  try {
    return { result: await fn(), retried: false };
  } catch {
    const result = await fn();
    return { result, retried: true };
  }
}

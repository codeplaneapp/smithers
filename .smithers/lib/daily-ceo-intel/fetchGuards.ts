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
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true; // fe80::/10 link local
  if (normalized.startsWith("::ffff:")) return isBlockedIpv4(normalized.slice("::ffff:".length));
  return false;
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal")) {
    throw new Error(`Refusing to fetch blocked hostname: ${hostname}`);
  }
  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0) throw new Error(`Could not resolve hostname: ${hostname}`);
  for (const { address, family } of addresses) {
    const blocked = family === 4 || isIPv4(address) ? isBlockedIpv4(address) : isIPv6(address) ? isBlockedIpv6(address) : true;
    if (blocked) throw new Error(`Refusing to fetch blocked/private address ${address} for hostname ${hostname}`);
  }
}

export type GuardedFetchOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  allowedContentType?: RegExp;
};

export type GuardedFetchResult = {
  text: string;
  contentType: string | null;
  status: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5_000_000;

/** https-only, SSRF-blocked (private/loopback/link-local ranges), timed out, and size-capped GET. */
export async function guardedFetch(url: string, opts: GuardedFetchOptions = {}): Promise<GuardedFetchResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`Refusing non-https URL: ${url}`);
  await assertPublicHostname(parsed.hostname);

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: opts.headers,
      signal: controller.signal,
      redirect: "follow",
    });
    const contentType = response.headers.get("content-type");
    if (opts.allowedContentType && contentType && !opts.allowedContentType.test(contentType)) {
      throw new Error(`Unexpected content-type "${contentType}" for ${url}`);
    }
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const reader = response.body?.getReader();
    let text: string;
    if (!reader) {
      text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`Response exceeded ${maxBytes} bytes: ${url}`);
    } else {
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
      text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return { text, contentType, status: response.status };
  } finally {
    clearTimeout(timeout);
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

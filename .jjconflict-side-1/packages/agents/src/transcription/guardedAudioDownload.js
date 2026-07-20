import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_MAX_REDIRECTS = 5;
const MAX_CONFIGURED_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RFC6052_PREFIX_LENGTHS = /** @type {const} */ ([32, 40, 48, 56, 64, 96]);

/** @type {ReadonlyArray<readonly [string, number]>} */
const BLOCKED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** @type {ReadonlyArray<readonly [string, number]>} */
const BLOCKED_IPV6_CIDRS = [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

/**
 * @typedef {import("./createTranscriptionTool.ts").ResolvedAudioAddress} ResolvedAudioAddress
 * @typedef {import("./createTranscriptionTool.ts").AudioHostResolver} AudioHostResolver
 * @typedef {import("./createTranscriptionTool.ts").PinnedAudioTransport} PinnedAudioTransport
 * @typedef {{
 *   transport: PinnedAudioTransport,
 *   resolver?: AudioHostResolver,
 *   signal?: AbortSignal,
 *   allowedAudioHosts?: string[],
 *   allowPrivateAudioUrl?: boolean,
 *   maxRedirects?: number,
 * }} GuardedAudioDownloadOptions
 */

/**
 * Download an HTTP(S) resource without allowing DNS rebinding or redirect SSRF.
 *
 * The transport is deliberately address-aware. It must connect directly to the
 * supplied address using a fresh, non-pooled connection while preserving the
 * URL hostname for the HTTP Host header and TLS SNI. It must not resolve the
 * hostname itself or automatically follow redirects.
 *
 * @param {string | URL} rawUrl
 * @param {GuardedAudioDownloadOptions} options
 * @returns {Promise<Response>}
 */
export async function guardedAudioDownload(rawUrl, options) {
  if (!options || typeof options.transport !== "function") {
    throw new TypeError("guardedAudioDownload requires a pinned transport");
  }

  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_CONFIGURED_REDIRECTS) {
    throw new RangeError(`maxRedirects must be an integer between 0 and ${MAX_CONFIGURED_REDIRECTS}`);
  }

  const allowlist = normalizeAllowlist(options.allowedAudioHosts);
  const resolver = options.resolver ?? defaultAudioHostResolver;
  const visited = new Set();
  let currentUrl = parseHttpUrl(rawUrl, "audioUrl");
  let redirectsFollowed = 0;

  while (true) {
    options.signal?.throwIfAborted();

    const visitKey = canonicalRedirectKey(currentUrl);
    if (visited.has(visitKey)) {
      throw new Error(`Refusing audioUrl redirect loop at ${visitKey}`);
    }
    visited.add(visitKey);

    const hostname = normalizeHostname(currentUrl.hostname);
    const permitsPrivateAddress = assertHostPolicy(hostname, allowlist, options.allowPrivateAudioUrl === true);
    const addresses = await resolveAllAddresses(hostname, resolver, options.signal);

    if (!permitsPrivateAddress) {
      const blocked = addresses.find(({ address }) => isBlockedNetworkAddress(address));
      if (blocked) {
        throw new Error(
          `Refusing to fetch audioUrl host ${hostname}: resolved to a private, loopback, or link-local address (multicast and reserved ranges are also blocked): ${blocked.address}`,
        );
      }
    }

    options.signal?.throwIfAborted();
    const pinned = addresses[0];
    const response = await raceWithAbort(
      Promise.resolve(
        options.transport({
          url: new URL(currentUrl.href),
          address: pinned.address,
          family: pinned.family,
          signal: options.signal,
        }),
      ),
      options.signal,
    );
    assertTransportResponse(response);
    options.signal?.throwIfAborted();

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    disposeResponseBody(response);
    if (!location || !location.trim()) {
      throw new Error(`Audio download redirect ${response.status} is missing a Location header`);
    }

    let nextUrl;
    try {
      nextUrl = parseHttpUrl(new URL(location, currentUrl), "audioUrl redirect");
    } catch (error) {
      if (error instanceof Error && /must be an http\(s\) URL/.test(error.message)) throw error;
      throw new Error(`Invalid audioUrl redirect Location: ${location}`, { cause: error });
    }

    if (redirectsFollowed >= maxRedirects) {
      throw new Error(`Audio download exceeded the ${maxRedirects}-redirect limit`);
    }
    redirectsFollowed += 1;
    currentUrl = nextUrl;
  }
}

/**
 * @param {string} hostname
 * @param {Set<string> | undefined} allowlist
 * @param {boolean} allowPrivateAudioUrl
 * @returns {boolean}
 */
function assertHostPolicy(hostname, allowlist, allowPrivateAudioUrl) {
  if (allowlist) {
    if (!allowlist.has(hostname)) {
      throw new Error(`audioUrl host ${hostname} is not in allowedAudioHosts`);
    }
    return true;
  }
  if (allowPrivateAudioUrl) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`Refusing to fetch audioUrl from a private, loopback, or link-local host: ${hostname}`);
  }
  return false;
}

/**
 * @param {string} hostname
 * @param {AudioHostResolver} resolver
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Array<{ address: string, family: 4 | 6 }>>}
 */
async function resolveAllAddresses(hostname, resolver, signal) {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }

  let answers;
  try {
    answers = await raceWithAbort(Promise.resolve(resolver(hostname, { signal })), signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`Failed to resolve every address for audioUrl host ${hostname}`, { cause: error });
  }
  signal?.throwIfAborted();

  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error(`audioUrl host ${hostname} resolved to no addresses`);
  }

  /** @type {Array<{ address: string, family: 4 | 6 }>} */
  const normalized = [];
  const seen = new Set();
  for (const answer of answers) {
    const address = typeof answer?.address === "string" ? answer.address.trim().toLowerCase() : "";
    const actualFamily = isIP(address);
    if (actualFamily !== 4 && actualFamily !== 6) {
      throw new Error(`Resolver returned an invalid address for audioUrl host ${hostname}: ${address || "<empty>"}`);
    }
    if (answer.family !== undefined && Number(answer.family) !== actualFamily) {
      throw new Error(
        `Resolver returned address-family mismatch for ${address}: declared ${answer.family}, detected IPv${actualFamily}`,
      );
    }
    const key = `${actualFamily}:${address}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ address, family: actualFamily });
    }
  }
  return normalized;
}

/**
 * @param {string} hostname
 * @param {{ signal?: AbortSignal }} options
 * @returns {Promise<ResolvedAudioAddress[]>}
 */
async function defaultAudioHostResolver(hostname, options) {
  options.signal?.throwIfAborted();
  const answers = await raceWithAbort(lookup(hostname, { all: true, verbatim: true }), options.signal);
  return answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
}

/** @param {string} address */
function isBlockedNetworkAddress(address) {
  const family = isIP(address);
  if (family === 4) return isInAnyCidr(parseIPv4(address), BLOCKED_IPV4_CIDRS, parseIPv4);
  if (family !== 6) return true;

  const bytes = parseIPv6(address);
  if (isIPv4Mapped(bytes)) {
    return isInAnyCidr(bytes.slice(12), BLOCKED_IPV4_CIDRS, parseIPv4);
  }
  if (hasBlockedRfc6052Embedding(bytes)) return true;
  // Current globally routable unicast IPv6 space is allocated from 2000::/3.
  // Fail closed on every other encoding before applying the special-use list.
  if (!hasCidrPrefix(bytes, parseIPv6("2000::"), 3)) return true;
  return isInAnyCidr(bytes, BLOCKED_IPV6_CIDRS, parseIPv6);
}

/**
 * RFC 6052 permits six prefix lengths and does not provide an on-address marker
 * that identifies which one a deployment selected. NAT64 may also be advertised
 * without DNS64, and deployments may use different prefixes for different IPv4
 * ranges. Inspect every structurally valid layout rather than assuming that a
 * negative or partial discovery result proves an ambiguous candidate safe.
 *
 * Bits 64-71 must be the zero-valued u octet (or zero inside a /96 prefix).
 * Suffix bits are deliberately ignored because RFC 6052 says translators
 * SHOULD ignore non-zero values and proceed as if they were zero. All candidates,
 * including 0.0.0.0, remain subject to the blocked IPv4 policy.
 *
 * @param {Uint8Array} bytes
 */
function hasBlockedRfc6052Embedding(bytes) {
  if (bytes[8] !== 0) return false;
  return RFC6052_PREFIX_LENGTHS.some((prefixLength) =>
    isInAnyCidr(extractRfc6052Ipv4(bytes, prefixLength), BLOCKED_IPV4_CIDRS, parseIPv4),
  );
}

/**
 * @param {Uint8Array} bytes
 * @param {32 | 40 | 48 | 56 | 64 | 96} prefixLength
 * @returns {Uint8Array}
 */
function extractRfc6052Ipv4(bytes, prefixLength) {
  if (prefixLength === 32) return Uint8Array.from([bytes[4], bytes[5], bytes[6], bytes[7]]);
  if (prefixLength === 40) return Uint8Array.from([bytes[5], bytes[6], bytes[7], bytes[9]]);
  if (prefixLength === 48) return Uint8Array.from([bytes[6], bytes[7], bytes[9], bytes[10]]);
  if (prefixLength === 56) return Uint8Array.from([bytes[7], bytes[9], bytes[10], bytes[11]]);
  if (prefixLength === 64) return Uint8Array.from([bytes[9], bytes[10], bytes[11], bytes[12]]);
  return bytes.slice(12);
}

/** @param {Uint8Array} bytes */
function isIPv4Mapped(bytes) {
  return bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * @param {Uint8Array} address
 * @param {ReadonlyArray<readonly [string, number]>} cidrs
 * @param {(value: string) => Uint8Array} parse
 */
function isInAnyCidr(address, cidrs, parse) {
  return cidrs.some(([network, prefixLength]) => hasCidrPrefix(address, parse(network), prefixLength));
}

/**
 * @param {Uint8Array} address
 * @param {Uint8Array} network
 * @param {number} prefixLength
 */
function hasCidrPrefix(address, network, prefixLength) {
  const wholeBytes = Math.floor(prefixLength / 8);
  const remainingBits = prefixLength % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (address[index] !== network[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[wholeBytes] & mask) === (network[wholeBytes] & mask);
}

/** @param {string} address */
function parseIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address: ${address}`);
  }
  return Uint8Array.from(parts);
}

/** @param {string} address */
function parseIPv6(address) {
  let source = address.toLowerCase();
  const zoneIndex = source.indexOf("%");
  if (zoneIndex !== -1) source = source.slice(0, zoneIndex);

  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    const ipv4 = parseIPv4(source.slice(lastColon + 1));
    source = `${source.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) throw new Error(`Invalid IPv6 address: ${address}`);
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new Error(`Invalid IPv6 address: ${address}`);
  }
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    throw new Error(`Invalid IPv6 address: ${address}`);
  }
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

/** @param {string[]} [entries] */
function normalizeAllowlist(entries) {
  if (!entries || entries.length === 0) return undefined;
  return new Set(entries.map((entry) => normalizeHostname(entry)));
}

/** @param {string} hostname */
function normalizeHostname(hostname) {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "").toLowerCase();
}

/** @param {URL} url */
function canonicalRedirectKey(url) {
  const canonical = new URL(url.href);
  canonical.hash = "";
  return canonical.href;
}

/**
 * @param {string | URL} value
 * @param {string} label
 */
function parseHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${String(value)}`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be an http(s) URL, got ${url.protocol}`);
  }
  return url;
}

/** @param {unknown} response */
function assertTransportResponse(response) {
  if (
    !response ||
    typeof response !== "object" ||
    typeof /** @type {{ status?: unknown }} */ (response).status !== "number" ||
    typeof /** @type {{ headers?: { get?: unknown } }} */ (response).headers?.get !== "function"
  ) {
    throw new TypeError("Pinned audio transport returned an invalid response");
  }
}

/** @param {Response} response */
function disposeResponseBody(response) {
  try {
    // A hostile or broken stream can return a never-settling cancellation
    // promise. Start disposal so the transport destroys the one-off socket,
    // but never let that promise stall redirect policy enforcement.
    void response.body?.cancel().catch(() => {});
  } catch {
    // The redirect response is being discarded, so a cancellation error is immaterial.
  }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
async function raceWithAbort(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

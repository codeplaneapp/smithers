// IANA special-purpose registries last reviewed 2026-07-10:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/

const IPV4_GLOBAL_EXCEPTIONS = new Set([
  0xc0000009, // 192.0.0.9/32 PCP Anycast
  0xc000000a, // 192.0.0.10/32 TURN Anycast
]);

/** @type {ReadonlyArray<readonly [number, number]>} */
const IPV4_NON_GLOBAL_CIDRS = Object.freeze([
  [0x00000000, 8],  // 0.0.0.0/8 this network
  [0x0a000000, 8],  // 10.0.0.0/8 private use
  [0x64400000, 10], // 100.64.0.0/10 shared address space
  [0x7f000000, 8],  // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local
  [0xac100000, 12], // 172.16.0.0/12 private use
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 documentation
  [0xc0586300, 24], // 192.88.99.0/24 deprecated 6to4 relay anycast
  [0xc0a80000, 16], // 192.168.0.0/16 private use
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 documentation
  [0xcb007100, 24], // 203.0.113.0/24 documentation
  [0xe0000000, 3],  // 224.0.0.0/3 multicast, reserved, and broadcast
]);

/**
 * Normalize WHATWG-supported IP spellings without resolving DNS. In
 * particular, integer, octal, and hexadecimal IPv4 hosts normalize to the
 * address Fetch would contact.
 *
 * @param {string} hostname
 * @returns {string}
 */
function normalizeHostname(hostname) {
  const raw = hostname.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!raw) return raw;
  try {
    const parsed = new URL(raw.includes(":") ? `http://[${raw}]/` : `http://${raw}/`);
    return parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  } catch {
    return raw;
  }
}

/**
 * @param {string} input
 * @returns {number | null}
 */
function parseIpv4(input) {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * @param {number} value
 * @param {number} base
 * @param {number} prefixLength
 * @returns {boolean}
 */
function inIpv4Cidr(value, base, prefixLength) {
  const blockSize = 2 ** (32 - prefixLength);
  return Math.floor(value / blockSize) === Math.floor(base / blockSize);
}

/**
 * @param {string} input
 * @returns {bigint | null}
 */
function parseIpv6(input) {
  if (!input.includes(":")) return null;
  let source = input.toLowerCase();

  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    const ipv4 = parseIpv4(source.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === null) return null;
    const high = Math.floor(ipv4 / 0x10000).toString(16);
    const low = (ipv4 % 0x10000).toString(16);
    source = `${source.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...head, ...tail].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;

  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const parts = halves.length === 2
    ? [...head, ...Array(missing).fill("0"), ...tail]
    : head;
  if (parts.length !== 8) return null;

  let value = 0n;
  for (const part of parts) {
    value = (value << 16n) | BigInt(Number.parseInt(part, 16));
  }
  return value;
}

/** @param {string} input @returns {bigint} */
function ipv6(input) {
  const value = parseIpv6(input);
  if (value === null) throw new Error(`Invalid internal IPv6 constant: ${input}`);
  return value;
}

/**
 * @param {bigint} value
 * @param {bigint} base
 * @param {number} prefixLength
 * @returns {boolean}
 */
function inIpv6Cidr(value, base, prefixLength) {
  const shift = BigInt(128 - prefixLength);
  return (value >> shift) === (base >> shift);
}

const IPV6_PUBLIC_UNICAST = /** @type {const} */ ([ipv6("2000::"), 3]);
const IPV6_IETF_ASSIGNMENTS = /** @type {const} */ ([ipv6("2001::"), 23]);

/** @type {ReadonlyArray<readonly [bigint, number]>} */
const IPV6_IETF_GLOBAL_EXCEPTIONS = Object.freeze([
  [ipv6("2001:1::1"), 128],
  [ipv6("2001:1::2"), 128],
  [ipv6("2001:1::3"), 128],
  [ipv6("2001:3::"), 32],
  [ipv6("2001:4:112::"), 48],
  [ipv6("2001:20::"), 28],
  [ipv6("2001:30::"), 28],
]);

/** @type {ReadonlyArray<readonly [bigint, number]>} */
const IPV6_NON_GLOBAL_CIDRS = Object.freeze([
  [ipv6("2001:db8::"), 32], // documentation
  [ipv6("2002::"), 16],     // 6to4
  [ipv6("3fff::"), 20],     // documentation
]);

/**
 * Return whether a hostname is an IP literal outside ordinary public unicast
 * space. Hostnames return false: this helper deliberately performs no DNS
 * lookup, so callers must enforce DNS/private-range egress separately.
 *
 * IPv4 follows the IANA special-purpose registry's Globally Reachable field
 * and also rejects multicast. IPv6 permits 2000::/3, then applies the IANA
 * non-global ranges and more-specific global exceptions within that space.
 * IPv4-mapped and translation forms are rejected; callers can explicitly opt
 * in to an intentional internal/special endpoint at their policy layer.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isNonGlobalIpLiteral(hostname) {
  if (typeof hostname !== "string") return false;
  const normalized = normalizeHostname(hostname);

  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== null) {
    if (IPV4_GLOBAL_EXCEPTIONS.has(ipv4)) return false;
    return IPV4_NON_GLOBAL_CIDRS.some(([base, prefix]) => inIpv4Cidr(ipv4, base, prefix));
  }

  const ipv6Value = parseIpv6(normalized);
  if (ipv6Value === null) return false;
  if (!inIpv6Cidr(ipv6Value, ...IPV6_PUBLIC_UNICAST)) return true;
  if (inIpv6Cidr(ipv6Value, ...IPV6_IETF_ASSIGNMENTS)) {
    return !IPV6_IETF_GLOBAL_EXCEPTIONS.some(([base, prefix]) =>
      inIpv6Cidr(ipv6Value, base, prefix));
  }
  return IPV6_NON_GLOBAL_CIDRS.some(([base, prefix]) =>
    inIpv6Cidr(ipv6Value, base, prefix));
}

/**
 * `smithers bug`: a report an operator can send without pasting their secrets
 * into a browser.
 *
 * The value of the command is that it collects the context a maintainer always
 * asks for — versions, platform, the runs in this project, and one run's event
 * digest — and that it scrubs the collected text before it leaves the machine.
 * The scrubbing rules are ported verbatim from 0.x, where each one was added
 * after a real report arrived carrying a credential.
 *
 * @since 1.0.0
 */

/**
 * Where reports are posted when the environment names no other endpoint.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultEndpoint = "https://bug.smithers.sh/api/bugs"

/** Object keys whose values are redacted wholesale, whatever they hold. */
const secretKey = /(?:api[-_]?key|[-_]key$|^key$|token|secret|password|credential|authorization|dsn|connection)/i

/**
 * Redacts secret-looking material inside free text.
 *
 * Each rule answers a way a credential has actually reached a report: inline
 * credentials in a connection string, a bearer header copied out of a log, the
 * provider token formats that carry no `KEY=` context, and `KEY=value` pairs.
 *
 * @category conversions
 * @since 1.0.0
 */
export const scrubText = (text: string): string =>
  text
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s:@/]+@/gi, "$1:[REDACTED]@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{35,}/g, "[REDACTED]")
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?)=("[^"]*"|'[^']*'|\S+)/g, "$1=[REDACTED]")
    .replace(
      /"([A-Za-z0-9_-]*(?:key|token|secret|password|credential)[A-Za-z0-9_-]*)"(\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      "\"$1\"$2\"[REDACTED]\""
    )

/**
 * Recursively scrubs a JSON-safe value.
 *
 * @category conversions
 * @since 1.0.0
 */
export const scrub = (value: unknown): unknown => {
  if (typeof value === "string") return scrubText(value)
  if (Array.isArray(value)) return value.map(scrub)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, secretKey.test(key) ? "[REDACTED]" : scrub(entry)])
    )
  }
  return value
}

/**
 * The report body.
 *
 * @category models
 * @since 1.0.0
 */
export interface Report {
  readonly summary: string
  readonly version: string
  readonly platform: string
  readonly node: string
  readonly runs: unknown
  readonly digest?: unknown
}

/**
 * Assembles a scrubbed report.
 *
 * @category constructors
 * @since 1.0.0
 */
export const report = (input: Report): Report => scrub(input) as Report

/**
 * How long the post is allowed to take before the command gives up.
 *
 * @category constants
 * @since 1.0.0
 */
export const timeoutMs = 15_000

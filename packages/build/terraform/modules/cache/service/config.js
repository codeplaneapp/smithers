/*
 * Startup configuration, validated before anything binds a port or opens a
 * connection.
 *
 * A cache that starts with a NaN port or an undefined connection string fails
 * later, in a request, as a 503 that looks like a storage outage. Refusing at
 * startup with the list of what is wrong is the only diagnosis an operator can
 * act on.
 */

import { maxArtifactBodyBytes } from "./protocol.js"

/** The largest artifact bound an operator may configure. */
export const maxConfigurableBodyBytes = maxArtifactBodyBytes

const defaultPort = 8080
const defaultMaxBodyBytes = maxArtifactBodyBytes
const maxDatabaseUrlBytes = 8192
const maxTokenBytes = 4096
const textEncoder = new TextEncoder()
const controlCharacters = /[\u0000-\u001f\u007f]/

const utf8Bytes = (value) => textEncoder.encode(value).byteLength

/** Parses a decimal integer, rejecting "8080.5", "0x10", "1e3", and " 12". */
const integer = (text) => (typeof text === "string" && /^[0-9]+$/.test(text) ? Number(text) : Number.NaN)

const sha256Hex = (text) => new Bun.CryptoHasher("sha256").update(text, "utf8").digest("hex")

/**
 * Validates the service environment.
 *
 * Returns every problem at once rather than the first, so one restart reports
 * the whole misconfiguration. An empty `SMITHERS_CACHE_TOKEN` is the documented
 * development mode: the bearer check is disabled, and the module publishes the
 * port on loopback only.
 *
 * @category constructors
 */
export const readConfig = (env) => {
  const problems = []

  const rawPort = env.PORT ?? String(defaultPort)
  const port = integer(rawPort)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    problems.push("PORT must be an integer between 1 and 65535")
  }

  const rawMaxBodyBytes = env.SMITHERS_CACHE_MAX_BODY_BYTES ?? String(defaultMaxBodyBytes)
  const maxArtifactBytes = integer(rawMaxBodyBytes)
  if (
    !Number.isSafeInteger(maxArtifactBytes) ||
    maxArtifactBytes < 1 ||
    maxArtifactBytes > maxConfigurableBodyBytes
  ) {
    problems.push(
      `SMITHERS_CACHE_MAX_BODY_BYTES must be an integer between 1 and ${maxConfigurableBodyBytes}`
    )
  }

  const databaseUrl = env.DATABASE_URL ?? ""
  let parsedDatabaseUrl = null
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    problems.push("DATABASE_URL must be set to the cache connection string")
  } else if (utf8Bytes(databaseUrl) > maxDatabaseUrlBytes || controlCharacters.test(databaseUrl)) {
    problems.push(`DATABASE_URL must be at most ${maxDatabaseUrlBytes} bytes and contain no control characters`)
  } else {
    try {
      parsedDatabaseUrl = new URL(databaseUrl)
    } catch {
      // The value is never echoed: a connection string carries the password.
    }
    if (
      parsedDatabaseUrl === null ||
      (parsedDatabaseUrl.protocol !== "postgres:" && parsedDatabaseUrl.protocol !== "postgresql:") ||
      parsedDatabaseUrl.hostname.length === 0 ||
      parsedDatabaseUrl.pathname.length <= 1 ||
      parsedDatabaseUrl.hash.length > 0
    ) {
      problems.push("DATABASE_URL must be a well-formed postgres URL with a host and database name")
    }
  }

  const token = env.SMITHERS_CACHE_TOKEN ?? ""
  if (typeof token !== "string" || controlCharacters.test(token)) {
    problems.push("SMITHERS_CACHE_TOKEN must not contain control characters")
  } else if (
    token !== "" && (
      token.length < 16 ||
      utf8Bytes(token) > maxTokenBytes ||
      !/^[!-~]+$/.test(token)
    )
  ) {
    // A token travels as an `Authorization` credential, and a credential is
    // visible ASCII with no spaces. A token carrying a space hashes to
    // something no client can present, because the header value arrives with
    // its optional whitespace already trimmed; the symptom is every request
    // answering 401 with nothing to read. The shape is the one variables.tf
    // validates, so both ends refuse the same values, and the value itself is
    // never echoed. Empty stays the documented development mode.
    problems.push(
      `SMITHERS_CACHE_TOKEN must be 16-${maxTokenBytes} printable ASCII bytes with no spaces, ` +
        "or empty for development mode"
    )
  }

  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    config: {
      port,
      maxArtifactBytes,
      databaseUrl,
      // The token itself is never retained, so nothing downstream can log it.
      tokenHash: token === "" ? null : sha256Hex(token),
      development: token === "",
      hostname: token === "" ? "127.0.0.1" : "0.0.0.0"
    }
  }
}

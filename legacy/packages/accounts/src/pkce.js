import { createHash, randomBytes } from "node:crypto";

const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/;
const CODE_VERIFIER_MIN_LENGTH = 43;
const CODE_VERIFIER_MAX_LENGTH = 128;
const CODE_VERIFIER_DEFAULT_RANDOM_BYTES = 32;
const CODE_VERIFIER_MIN_RANDOM_BYTES = 32;
const CODE_VERIFIER_MAX_RANDOM_BYTES = 96;

function base64urlNoPadding(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function validateCodeVerifierByteLength(byteLength) {
  if (!Number.isInteger(byteLength)) {
    throw new TypeError("PKCE code_verifier byteLength must be an integer");
  }
  if (byteLength < CODE_VERIFIER_MIN_RANDOM_BYTES || byteLength > CODE_VERIFIER_MAX_RANDOM_BYTES) {
    throw new RangeError("PKCE code_verifier byteLength must be 32..96 bytes");
  }
}

/**
 * Creates an RFC 7636 PKCE code_verifier using high-entropy random bytes.
 *
 * @param {number} [byteLength]
 * @returns {string}
 */
export function createCodeVerifier(byteLength = CODE_VERIFIER_DEFAULT_RANDOM_BYTES) {
  validateCodeVerifierByteLength(byteLength);

  return base64urlNoPadding(randomBytes(byteLength));
}

/**
 * Derives an RFC 7636 S256 code_challenge for a code_verifier.
 *
 * @param {string} codeVerifier
 * @returns {string}
 */
export function deriveCodeChallenge(codeVerifier) {
  if (typeof codeVerifier !== "string") {
    throw new TypeError("PKCE code_verifier must be a string");
  }
  if (codeVerifier.length < CODE_VERIFIER_MIN_LENGTH || codeVerifier.length > CODE_VERIFIER_MAX_LENGTH) {
    throw new RangeError("PKCE code_verifier must be 43..128 characters");
  }
  if (!CODE_VERIFIER_PATTERN.test(codeVerifier)) {
    throw new TypeError("PKCE code_verifier must contain only RFC 7636 unreserved characters");
  }

  return base64urlNoPadding(createHash("sha256").update(codeVerifier, "ascii").digest());
}

/**
 * Creates a full RFC 7636 S256 PKCE parameter set.
 *
 * @param {number} [byteLength]
 * @returns {{ codeVerifier: string; codeChallenge: string; codeChallengeMethod: "S256" }}
 */
export function createPkcePair(byteLength = CODE_VERIFIER_DEFAULT_RANDOM_BYTES) {
  const codeVerifier = createCodeVerifier(byteLength);
  return {
    codeVerifier,
    codeChallenge: deriveCodeChallenge(codeVerifier),
    codeChallengeMethod: "S256",
  };
}

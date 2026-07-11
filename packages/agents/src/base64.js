/**
 * Compute decoded base64 length without allocating the decoded payload. The
 * parser accepts standard and URL-safe alphabets plus ASCII whitespace, which
 * matches Node/Bun Buffer decoding closely enough to fail closed before the
 * allocation.
 *
 * @param {string} value
 * @returns {number}
 */
function decodedBase64Length(value) {
  let characters = 0;
  let dataCharacters = 0;
  let padding = 0;
  let sawPadding = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13 || code === 32) continue;
    const char = value[index];
    if (char === "=") {
      sawPadding = true;
      padding += 1;
      characters += 1;
      if (padding > 2) throw new Error("Invalid base64 input");
      continue;
    }
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      char === "+" || char === "/" || char === "-" || char === "_";
    if (!valid || sawPadding) throw new Error("Invalid base64 input");
    characters += 1;
    dataCharacters += 1;
  }
  if (padding > 0) {
    if (characters % 4 !== 0 || (padding === 1 && dataCharacters % 4 !== 3) ||
      (padding === 2 && dataCharacters % 4 !== 2)) {
      throw new Error("Invalid base64 input");
    }
  } else if (characters % 4 === 1) {
    throw new Error("Invalid base64 input");
  }
  return Math.max(0, Math.floor(characters * 3 / 4) - padding);
}

/**
 * @param {string} value
 * @param {number} maxBytes
 * @param {string} label
 * @returns {Buffer}
 */
export function decodeBase64Bounded(value, maxBytes, label) {
  assertBase64WithinLimit(value, maxBytes, label);
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${label} exceeds the maximum size of ${maxBytes} bytes`);
  }
  return bytes;
}

/**
 * @param {string} value
 * @param {number} maxBytes
 * @param {string} label
 */
export function assertBase64WithinLimit(value, maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`${label} byte limit must be a non-negative safe integer`);
  }
  if (decodedBase64Length(value) > maxBytes) {
    throw new Error(`${label} exceeds the maximum size of ${maxBytes} bytes`);
  }
}

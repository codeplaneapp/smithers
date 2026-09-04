/**
 * Constant-time byte comparison of two strings of equal byte length. Length
 * mismatch returns false up front but still in O(1) time vs the longer of the
 * two — fine here, the inputs are hex digests or short fixed-shape tokens, so
 * the length is not a secret.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

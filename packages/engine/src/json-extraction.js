/**
 * Extract the first balanced JSON object from text.
 *
 * @param {string} str
 * @returns {string | null}
 */
export function extractBalancedJson(str) {
  const start = str.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return str.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Extract the balanced JSON object with the latest end from text — the object
 * whose closing brace is rightmost, matching the previous "max end over every
 * `{` start" behavior (so a trailing top-level object wins, and the deepest
 * closed object wins when its encloser never closes).
 *
 * Single left-to-right pass with a stack of open-brace positions: each `}`
 * outside a string pops its matching `{`, forming a balanced span, and the last
 * such span (largest end, since `i` is monotonic) is returned. This is O(n)
 * time and allocation; the old version re-`slice`d and re-scanned from every
 * `{`, which was O(n^2) and blocked the event loop ~1.7s on a 200KB payload —
 * this runs on the agent final-output extraction hot path.
 *
 * @param {string} str
 * @returns {string | null}
 */
export function extractLastBalancedJson(str) {
  /** @type {number[]} */
  const openStack = [];
  let inString = false;
  let escape = false;
  let bestStart = -1;
  let bestEnd = -1;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") {
      openStack.push(i);
    } else if (c === "}") {
      const start = openStack.pop();
      if (start !== undefined) {
        // `i` only increases, so each matched close ends later than the
        // last; the final matched close is the max-end span.
        bestStart = start;
        bestEnd = i + 1;
      }
    }
  }
  return bestEnd >= 0 ? str.slice(bestStart, bestEnd) : null;
}

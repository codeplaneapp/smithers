/**
 * A code fence long enough that untrusted content cannot break out of it: one
 * backtick more than the longest backtick run in the content, minimum three.
 *
 * Both threats depend on this: in agent prompts a short fence lets PR code close
 * the fence early and inject instructions; in GitHub PR bodies it lets the same
 * code escape a ```suggestion block and forge markdown. GFM treats longer
 * fences as valid, including for suggestion blocks, so widening is always safe.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(longest + 1, 3));
}

/**
 * Render an untrusted fenced block within an exact aggregate budget, including
 * both dynamic fence lines. Binary search is necessary because truncating a
 * backtick-heavy body also shortens the fence itself.
 */
export function boundedFencedBlock(
  content: string,
  language: string,
  maxChars: number,
  marker: string,
): string {
  const render = (body: string) => {
    const fence = fenceFor(body);
    return `${fence}${language}\n${body}\n${fence}`;
  };
  const complete = render(content);
  if (complete.length <= maxChars) return complete;

  let low = 0;
  let high = content.length;
  let best = render(marker);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(`${content.slice(0, middle)}\n${marker}`);
    if (candidate.length <= maxChars) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best.length > maxChars) throw new Error("fenced prompt block budget is too small for its marker");
  return best;
}

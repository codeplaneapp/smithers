/**
 * CommonMark fenced-code tracking, shared by every markdown scanner in the
 * vault lane.
 *
 * Fence state is the opening fence's CHARACTER and LENGTH, never a boolean.
 * A boolean toggle — which is what the outline parser carried, and what the
 * wikilink scanner carried before it — lets a `~~~` line, or a shorter run of
 * the same character, close a block it never opened. The real closer then
 * *opens* a fence, and the rest of the document is read with its code and prose
 * swapped. Only a run of the same character, at least as long as the opener,
 * with nothing after it, closes a fence; an unterminated fence runs to the end
 * of the document.
 */

/** An open fence: the character it opened with, and that run's length. */
export type Fence = { readonly marker: string; readonly length: number };

/** Fence state after a line, plus whether the line itself is fence or code. */
export type FenceStep = { readonly fence: Fence | null; readonly fenced: boolean };

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * Advance fence state across one line. Callers thread the returned `fence` into
 * the next call and skip parsing on any line reported as `fenced`, so the fence
 * rules live here rather than in each scanner.
 */
export function stepFence(line: string, fence: Fence | null): FenceStep {
  const match = FENCE_RE.exec(line);
  const run = match?.[1];
  const info = match?.[2] ?? "";
  if (fence) {
    const closes = run !== undefined && run[0] === fence.marker && run.length >= fence.length && info.trim() === "";
    return { fence: closes ? null : fence, fenced: true };
  }
  // A backtick fence's info string may not itself contain a backtick.
  if (run !== undefined && !(run[0] === "`" && info.includes("`"))) {
    return { fence: { marker: run[0]!, length: run.length }, fenced: true };
  }
  return { fence: null, fenced: false };
}

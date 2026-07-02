// Shared helpers for embedding untrusted diff/code content in agent prompts.

export const perFileDiffLimit = 20_000;

export function trimDiff(diff: string): string {
  if (diff.length <= perFileDiffLimit) return diff;
  return `${diff.slice(0, perFileDiffLimit)}\n[diff truncated for prompt size]`;
}

// A fence must be longer than any backtick run inside the content, or the
// content can close the fence early and inject prompt instructions.
export function fenceFor(content: string): string {
  const longestRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  return "`".repeat(Math.max(longestRun + 1, 3));
}

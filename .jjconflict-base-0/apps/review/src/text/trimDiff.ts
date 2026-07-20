// Cap a single file's diff before embedding it in an agent prompt, so one huge
// file cannot crowd out the rest of the review context.
const perFileDiffLimit = 20_000;

export function trimDiff(diff: string): string {
  if (diff.length <= perFileDiffLimit) return diff;
  return `${diff.slice(0, perFileDiffLimit)}\n[diff truncated for prompt size]`;
}

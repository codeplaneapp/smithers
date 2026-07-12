// Cap a single file's diff before embedding it in an agent prompt, so one huge
// file cannot crowd out the rest of the review context.
const perFileDiffLimit = 20_000;

export function trimPromptContent(content: string, limit: number, marker: string): string {
  if (content.length <= limit) return content;
  return `${content.slice(0, limit)}\n${marker}`;
}

export function trimDiff(diff: string): string {
  return trimPromptContent(diff, perFileDiffLimit, "[diff truncated for prompt size]");
}

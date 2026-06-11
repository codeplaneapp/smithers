import type { ReviewRunOutput } from "smithers-workflows/lib/open-code-review";
import type { ChangedFile } from "./changedFileSchema";

const PER_FILE_DIFF_LIMIT = 3_500;
const TOTAL_EXCERPT_LIMIT = 150_000;

function inventoryLine(file: ChangedFile): string {
  return `${file.status.toUpperCase().padEnd(8)} ${file.path} (+${file.insertions} −${file.deletions})`;
}

function findingLine(comment: ReviewRunOutput["comments"][number]): string {
  const lines = comment.startLine > 0 ? `:${comment.startLine}${comment.endLine > comment.startLine ? `-${comment.endLine}` : ""}` : "";
  return `- ${comment.path}${lines}: ${comment.content.split("\n")[0]}`;
}

function excerptOf(file: ChangedFile): string {
  if (!file.diff.trim()) return "";
  if (file.diff.length <= PER_FILE_DIFF_LIMIT) return file.diff;
  return `${file.diff.slice(0, PER_FILE_DIFF_LIMIT)}\n[diff truncated]`;
}

/**
 * Prompt for the narrator agent: turn a change set (plus review findings)
 * into a story a human can read top to bottom.
 */
export function buildNarratePrompt(args: {
  files: ChangedFile[];
  comments: ReviewRunOutput["comments"];
  background: string;
  mode: string;
  ref: string;
}): string {
  const byChurn = [...args.files].sort(
    (a, b) => b.insertions + b.deletions - (a.insertions + a.deletions) || a.path.localeCompare(b.path),
  );

  const excerpts: string[] = [];
  let excerptBudget = TOTAL_EXCERPT_LIMIT;
  let omitted = 0;
  for (const file of byChurn) {
    const excerpt = excerptOf(file);
    if (!excerpt || excerpt.length > excerptBudget) {
      omitted += 1;
      continue;
    }
    excerptBudget -= excerpt.length;
    excerpts.push(`--- ${file.path} (${file.status}, +${file.insertions} −${file.deletions})\n${excerpt}`);
  }

  return [
    "You are writing the walkthrough for a code change so a human can review it as a story, not as an alphabetical file list.",
    "",
    "Task: organize ALL changed files into chapters a reviewer reads top to bottom.",
    "",
    "Ordering contract:",
    "- Open with the motivating or central change: the chapter a reviewer must understand first.",
    "- Follow it through the supporting code in dependency order (what consumes what).",
    "- Keep tightly related files in the same chapter.",
    "- Put tests right after (or with) the code they prove.",
    "- End with mechanical changes: configuration, lockfiles, docs-only edits.",
    "",
    "Coverage contract:",
    "- Every changed file listed in the inventory appears in EXACTLY one chapter.",
    "- Use exact paths from the inventory. Do not invent paths.",
    "",
    "Writing contract:",
    "- headline: one sentence saying what this change does.",
    "- synopsis: a short paragraph describing the arc of the change.",
    "- Each chapter narrative: 2-5 sentences explaining why this chapter exists, how its files fit together, and what a reviewer should check. Mention review findings when they touch this chapter's files.",
    "- Each file role: one concrete line on what this file contributes to the chapter (shown in listings).",
    "- Each file narrative: 2-4 sentences the reviewer reads immediately before that file's diff. Walk them through the diff itself: what was added or removed, which functions/types changed and how behavior shifts, how it connects to the file they just read, and anything to scrutinize. Be concrete (name the identifiers); never restate the role line or pad.",
    "- The file narratives within a chapter should read as a continuous thread: each one can assume the reader has just read the previous diff.",
    "- Plain language. No filler.",
    "",
    "Output contract:",
    "- Return only structured data matching the Smithers output schema: { headline, synopsis, chapters: [{ title, narrative, files: [{ path, role, narrative }] }] }.",
    "",
    `Review target: ${args.mode} ${args.ref}`,
    `Requirement background: ${args.background.trim() || "none provided"}`,
    "",
    `Changed file inventory (${args.files.length} file(s)):`,
    ...args.files.map(inventoryLine),
    "",
    args.comments.length > 0 ? `Review findings (${args.comments.length}):` : "Review findings: none.",
    ...args.comments.map(findingLine),
    "",
    omitted > 0 ? `Diff excerpts (largest first; ${omitted} file(s) omitted for size, use the inventory for those):` : "Diff excerpts (largest first):",
    ...excerpts,
  ].join("\n");
}

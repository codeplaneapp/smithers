import {
  diffStatus,
  effectivePath,
  loadDiffs,
  normalizeOpenCodeReviewInput,
  resolveReviewTarget,
  type OpenCodeReviewInput,
  type PreviewOutput,
} from "smithers-workflows/lib/open-code-review";
import type { Changes } from "./changesSchema";

/**
 * Full diff records for every changed file, including files the review
 * filters exclude (tests, docs, configs). The review decides what agents
 * look at; the walkthrough shows a human everything.
 */
export async function collectChanges(input: OpenCodeReviewInput, preview: PreviewOutput): Promise<Changes> {
  const normalized = normalizeOpenCodeReviewInput(input);
  const target = await resolveReviewTarget(normalized);
  const diffs = await loadDiffs(target.repoDir, normalized);
  const previewByPath = new Map(preview.entries.map((entry) => [entry.path, entry]));
  const files = diffs
    // The app's own state dir: in not-yet-gitignored repos its db would show
    // up as a giant untracked "added" file on the very change set it reviews.
    .filter((diff) => effectivePath(diff) !== ".smithers-review" && !effectivePath(diff).startsWith(".smithers-review/"))
    .map((diff) => {
      const path = effectivePath(diff);
      const entry = previewByPath.get(path);
      // Untracked binaries are inlined as synthetic +lines by the workspace
      // diff; a NUL byte means this is not reviewable text.
      const binary = diff.isBinary || diff.diff.includes("\u0000");
      return {
        path,
        status: binary ? "binary" : diffStatus(diff),
        insertions: diff.insertions,
        deletions: diff.deletions,
        diff: binary ? "" : diff.diff,
        reviewed: entry?.willReview ?? false,
        excludeReason: entry?.excludeReason ?? "",
      };
    });
  return {
    files,
    totalFiles: files.length,
    totalInsertions: files.reduce((sum, file) => sum + file.insertions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

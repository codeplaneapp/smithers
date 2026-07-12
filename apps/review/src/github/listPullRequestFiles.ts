import { deriveReviewManifestCapabilities, manifestChangedFiles, readProtectedReviewManifest } from "../reviewManifest";
import type { PullRequestTarget } from "./resolvePullRequest";

export type PullRequestFile = {
  filename: string;
  additions: number;
  deletions: number;
  commentableLines: Set<number>;
};

/** Read only the protected local capability manifest; GitHub's files endpoint
 * is intentionally not consulted because its pagination is capped and mutable. */
export async function listPullRequestFiles(
  _repoDir: string,
  _pr: PullRequestTarget,
  manifestPath: string | undefined = process.env.SMITHERS_REVIEW_IMMUTABLE_MANIFEST,
): Promise<Map<string, PullRequestFile>> {
  if (!manifestPath?.trim()) throw new Error("listPullRequestFiles requires a protected review manifest");
  const records = readProtectedReviewManifest(manifestPath);
  const files = new Map<string, PullRequestFile>();
  for (const record of records) {
    if (files.has(record.filename)) throw new Error("protected review manifest contains duplicate filenames");
    files.set(record.filename, {
      filename: record.filename,
      additions: record.additions,
      deletions: record.deletions,
      commentableLines: deriveReviewManifestCapabilities(record).rightLines,
    });
  }
  if (files.size !== manifestChangedFiles(records).size) throw new Error("protected review manifest capabilities are inconsistent");
  return files;
}

import type { ArtifactPaths, FinalizeOutput } from "./schemas";

export function finalizeRun(params: {
  issueDateEt: string;
  storyCount: number;
  actionCount: number;
  artifactPaths: ArtifactPaths;
  verifyPassed: boolean;
  verifyErrors: string[];
  published: boolean;
  degraded: boolean;
  criticalFailed: boolean;
  invalidAssessmentCount: number;
  publishSkippedReason: string | null;
  commitSkippedReason: string | null;
}): FinalizeOutput {
  const warnings: string[] = [];
  if (params.criticalFailed) warnings.push("A critical source failed during this run.");
  if (params.invalidAssessmentCount > 0)
    warnings.push(`${params.invalidAssessmentCount} editorial assessment(s) cited an unknown SRC id and were dropped.`);
  if (!params.verifyPassed) warnings.push(...params.verifyErrors);
  if (!params.published && params.publishSkippedReason) warnings.push(`Publish: ${params.publishSkippedReason}`);
  if (params.commitSkippedReason) warnings.push(`Seen-state: ${params.commitSkippedReason}`);

  const status: FinalizeOutput["status"] = !params.verifyPassed
    ? "archived-unverified"
    : params.storyCount === 0
      ? "empty-day"
      : params.degraded
        ? "degraded"
        : params.published
          ? "published"
          : "archived";

  return {
    status,
    issueDateEt: params.issueDateEt,
    storyCount: params.storyCount,
    actionCount: params.actionCount,
    artifactPaths: params.artifactPaths,
    published: params.published,
    degraded: params.degraded,
    warnings,
    summary: `Issue ${params.issueDateEt}: ${status} — ${params.storyCount} stories, ${params.actionCount} actions, published=${params.published}.`,
  };
}

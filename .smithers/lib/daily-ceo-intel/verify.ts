import type { RunConfig } from "./config";
import type { Cluster, Issue, VerifyOutput } from "./schemas";

const INSTRUCTION_ECHO_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /disregard (all |any )?(previous|prior|above )?instructions/i,
  /you are now (a|an)\b/i,
  /system prompt/i,
  /new instructions:/i,
  /\bdo anything now\b/i,
  /reveal your (system|hidden) prompt/i,
];

function wordCount(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

function fullIssueText(issue: Issue): string {
  return [
    issue.headline,
    issue.intro,
    ...issue.topStories.flatMap((story) => [story.headline, story.body, story.whyItMatters]),
    ...issue.recommendedActions.map((action) => action.action),
    ...issue.briefs.map((brief) => brief.text),
    ...issue.lighterSide.map((item) => item.text),
    issue.coverageStatement,
  ].join(" \n ");
}

export function verifyIssue(
  issue: Issue,
  srcIdMap: Record<string, string>,
  clusters: Cluster[],
  config: RunConfig,
  windowStart: string,
  windowEnd: string,
  expectedIssueDateEt: string,
  attempt: number,
): VerifyOutput {
  const errors: string[] = [];
  // An unrendered prompt placeholder ("{props.issueDateEt}") or drifted date
  // corrupts the byline, the public JSON `date` field, and archive keys.
  if (issue.issueDateEt !== expectedIssueDateEt) {
    errors.push(`issueDateEt "${issue.issueDateEt}" must be exactly "${expectedIssueDateEt}".`);
  }
  const validIds = new Set(Object.keys(srcIdMap));
  const clusterById = new Map(clusters.map((cluster) => [cluster.srcId, cluster]));

  const referencedIds = [
    ...issue.topStories.map((story) => story.srcId),
    ...issue.recommendedActions.map((action) => action.srcId),
    ...issue.briefs.map((brief) => brief.srcId),
    ...issue.lighterSide.map((item) => item.srcId),
  ];
  for (const id of new Set(referencedIds)) {
    if (!validIds.has(id)) errors.push(`Invented SRC id "${id}" does not exist in this run's cluster set.`);
  }

  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  for (const story of issue.topStories) {
    const cluster = clusterById.get(story.srcId);
    if (!cluster?.publishedAt) continue;
    const publishedMs = Date.parse(cluster.publishedAt);
    if (!Number.isFinite(publishedMs) || publishedMs < startMs || publishedMs >= endMs) {
      errors.push(`Top story ${story.srcId} cites a cluster dated outside the 24h window.`);
    }
  }

  const topStoryIds = issue.topStories.map((story) => story.srcId);
  if (new Set(topStoryIds).size !== topStoryIds.length) errors.push("Top stories contain duplicate SRC ids.");
  const briefIds = new Set(issue.briefs.map((brief) => brief.srcId));
  for (const id of topStoryIds) if (briefIds.has(id)) errors.push(`SRC id ${id} appears in both top stories and briefs.`);

  if (!issue.headline.trim()) errors.push("Missing headline.");
  if (!issue.intro.trim()) errors.push("Missing intro.");
  if (!issue.coverageStatement.trim()) errors.push("Missing coverage statement.");
  if (!issue.quietDay && issue.topStories.length === 0) errors.push("No top stories on a non-quiet day.");

  if (issue.topStories.length > config.maxTopStories) errors.push(`Too many top stories: ${issue.topStories.length} > ${config.maxTopStories}.`);
  if (issue.recommendedActions.length > config.maxActions) errors.push(`Too many recommended actions: ${issue.recommendedActions.length} > ${config.maxActions}.`);
  if (issue.lighterSide.length > config.lighterSideMax) errors.push(`Too many Lighter Side items: ${issue.lighterSide.length} > ${config.lighterSideMax}.`);
  if (!issue.quietDay && issue.lighterSide.length < config.lighterSideMin) errors.push(`Too few Lighter Side items: ${issue.lighterSide.length} < ${config.lighterSideMin}.`);

  const requiredSections = ["topStories", "recommendedActions", "briefs", "lighterSide"] as const;
  const orderedSet = new Set<string>(issue.sectionOrder);
  if (issue.sectionOrder.length !== requiredSections.length || requiredSections.some((section) => !orderedSet.has(section))) {
    errors.push("sectionOrder must list each of topStories, recommendedActions, briefs, lighterSide exactly once.");
  } else if (issue.sectionOrder[issue.sectionOrder.length - 1] !== "lighterSide") {
    errors.push("The Lighter Side section must always be last.");
  }

  const words = wordCount(fullIssueText(issue));
  if (!issue.quietDay && (words < config.composeWordMin || words > config.composeWordMax)) {
    errors.push(`Word count ${words} is outside the ${config.composeWordMin}-${config.composeWordMax} band.`);
  }

  const text = fullIssueText(issue);
  for (const pattern of INSTRUCTION_ECHO_PATTERNS) {
    if (pattern.test(text)) errors.push(`Issue text echoes an instruction-like phrase matching ${pattern}.`);
  }

  const passed = errors.length === 0;
  return {
    passed,
    errors,
    attempt,
    summary: passed ? `Issue verified clean on attempt ${attempt}.` : `Issue failed verification on attempt ${attempt}: ${errors.length} error(s).`,
  };
}

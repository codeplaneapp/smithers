import type { RunConfig } from "./config";
import type {
  Cluster,
  EditorialAssessment,
  LighterSideCandidate,
  MergeAssessmentsOutput,
  RankAndSelectOutput,
  RankedStory,
} from "./schemas";

export function mergeAssessments(batches: EditorialAssessment[][], srcIdMap: Record<string, string>): MergeAssessmentsOutput {
  const validIds = new Set(Object.keys(srcIdMap));
  const flat = batches.flat();
  const assessments: EditorialAssessment[] = [];
  let invalidCount = 0;
  for (const assessment of flat) {
    if (!validIds.has(assessment.srcId)) {
      invalidCount += 1;
      continue;
    }
    assessments.push({ ...assessment, citedSourceIds: assessment.citedSourceIds.filter((id) => validIds.has(id)) });
  }
  return {
    assessedCount: assessments.length,
    invalidCount,
    assessments,
    summary: `${assessments.length} valid assessments merged (${invalidCount} dropped for citing an unknown SRC id).`,
  };
}

function scoreOf(assessment: EditorialAssessment, weights: RunConfig["weights"]): number {
  const total =
    assessment.smithersImpact * weights.smithersImpact +
    assessment.strategicRelevance * weights.strategicRelevance +
    assessment.actionability * weights.actionability +
    assessment.urgency * weights.urgency +
    assessment.novelty * weights.novelty +
    assessment.confidence * weights.confidence;
  const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);
  return weightSum === 0 ? 0 : total / weightSum;
}

const INFORMAL_KINDS = new Set(["reddit", "bluesky", "hn"]);

export function rankAndSelect(clusters: Cluster[], assessments: EditorialAssessment[], config: RunConfig): RankAndSelectOutput {
  const clusterById = new Map(clusters.map((cluster) => [cluster.srcId, cluster]));
  const ranked: RankedStory[] = assessments
    .map((assessment) => {
      const cluster = clusterById.get(assessment.srcId);
      if (!cluster) return null;
      return { ...assessment, title: cluster.title, excerpt: cluster.excerpt, score: scoreOf(assessment, config.weights) };
    })
    .filter((row): row is RankedStory => row !== null)
    .sort((a, b) => b.score - a.score);

  const maxPerCategory = Math.max(2, Math.ceil(config.maxTopStories / 3));
  const categoryCounts = new Map<string, number>();
  const topStories: RankedStory[] = [];
  const briefCandidates: RankedStory[] = [];
  const briefCap = config.maxTopStories;

  for (const story of ranked) {
    const primaryCategory = story.categories[0] ?? "general";
    const count = categoryCounts.get(primaryCategory) ?? 0;
    if (topStories.length < config.maxTopStories && count < maxPerCategory) {
      topStories.push(story);
      categoryCounts.set(primaryCategory, count + 1);
    } else if (briefCandidates.length < briefCap) {
      briefCandidates.push(story);
    }
  }

  const actions = ranked
    .filter((story) => story.recommendedAction.trim().length > 0)
    .sort((a, b) => b.actionability - a.actionability)
    .slice(0, config.maxActions)
    .map((story) => ({ srcId: story.srcId, action: story.recommendedAction }));

  const lighterSideCandidates: LighterSideCandidate[] = clusters
    .filter((cluster) => cluster.sourceKinds.some((kind) => INFORMAL_KINDS.has(kind)))
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, 10)
    .map((cluster) => ({ srcId: cluster.srcId, title: cluster.title, excerpt: cluster.excerpt }));

  return {
    topStories,
    actions,
    briefCandidates,
    lighterSideCandidates,
    selectedCount: topStories.length,
    summary: `Selected ${topStories.length} top stories, ${actions.length} actions, ${briefCandidates.length} briefs, ${lighterSideCandidates.length} lighter-side candidates from ${ranked.length} assessed clusters.`,
  };
}

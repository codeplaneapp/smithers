import { canonicalizeUrl, isSameEntity } from "./dedupe";
import type { Cluster, ClusterEventsOutput, Item } from "./schemas";

const CATEGORY_KEYWORDS: Array<[string, RegExp]> = [
  ["model-release", /\b(release[sd]?|launch(es|ed)?|generally available|\bga\b|v\d+(\.\d+)*)\b/i],
  ["funding", /\b(raise[sd]?|funding|series [a-e]|valuation)\b/i],
  ["safety", /\b(safety|alignment|jailbreak|red.?team)\b/i],
  ["tooling", /\b(sdk|\bcli\b|\bapi\b|agent|orchestrat)\b/i],
  ["research", /\b(paper|research|benchmark|arxiv)\b/i],
  ["acquisition", /\b(acquir|acquisition|merger)\b/i],
  ["outage", /\b(outage|incident|downtime|postmortem)\b/i],
];

function categoryHintsFor(text: string): string[] {
  const hints: string[] = [];
  for (const [category, pattern] of CATEGORY_KEYWORDS) {
    if (pattern.test(text)) hints.push(category);
    if (hints.length >= 3) break;
  }
  return hints;
}

function earliestPublishedAt(items: Item[]): string | null {
  const dated = items.map((item) => item.publishedAt).filter((value): value is string => value !== null);
  if (dated.length === 0) return null;
  return dated.sort()[0];
}

function padSrcId(index: number): string {
  return `SRC-${String(index + 1).padStart(3, "0")}`;
}

/** Loose event-level grouping (threshold 0.4, brand-disambiguated) on top of the already-deduped item set. */
export function clusterEvents(items: Item[]): ClusterEventsOutput {
  const groups: Item[][] = [];
  for (const item of items) {
    const matchIndex = groups.findIndex((group) => isSameEntity(group[0].title, item.title, 0.4));
    if (matchIndex >= 0) groups[matchIndex].push(item);
    else groups.push([item]);
  }

  const ordered = [...groups].sort((a, b) => {
    const aDate = earliestPublishedAt(a) ?? "";
    const bDate = earliestPublishedAt(b) ?? "";
    if (aDate !== bDate) return aDate.localeCompare(bDate);
    return a[0].title.localeCompare(b[0].title);
  });

  const clusters: Cluster[] = ordered.map((group, index) => {
    const representative = group[0];
    const sourceIds = [...new Set(group.flatMap((item) => [item.sourceId, ...item.corroboratingSourceIds]))];
    const sourceKinds = [...new Set(group.map((item) => item.sourceKind))];
    const excerptSource = group.find((item) => item.body.length > 0) ?? representative;
    return {
      srcId: padSrcId(index),
      title: representative.title,
      excerpt: excerptSource.body.slice(0, 280) || representative.title,
      canonicalUrl: canonicalizeUrl(representative.url),
      publishedAt: earliestPublishedAt(group),
      sourceIds,
      sourceKinds,
      itemIds: group.map((item) => item.id),
      isUpdate: group.some((item) => item.isUpdate),
      categoryHints: categoryHintsFor(`${representative.title} ${excerptSource.body}`),
    };
  });

  const srcIdMap: Record<string, string> = {};
  for (const cluster of clusters) srcIdMap[cluster.srcId] = cluster.canonicalUrl;

  return {
    clusterCount: clusters.length,
    clusters,
    srcIdMap,
    summary: `${clusters.length} event clusters assigned SRC-001..${padSrcId(Math.max(clusters.length - 1, 0))}.`,
  };
}

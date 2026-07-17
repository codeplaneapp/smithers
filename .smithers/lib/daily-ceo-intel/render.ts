import type { Cluster, CoverageRow, DateUncertainSample, Issue, RankedStory, RenderOutput } from "./schemas";

/** Public, pinned contract (spec "Report JSON contract") that the site Worker consumes from KV/R2. */
export type PublicIssue = {
  version: 1;
  date: string;
  generatedAt: string;
  window: { start: string; end: string };
  degraded: boolean;
  brief: Array<{ headline: string; text: string; storyId?: string }>;
  stories: PublicStory[];
  ourMove: Array<{ action: string; rationale: string; storyIds: string[] }>;
  lighterSide: Array<{ text: string; url: string; sourceName: string; kind: "post" | "meme" }>;
  coverage: {
    sourcesChecked: Array<{ id: string; name: string; ok: boolean; error?: string; itemCount: number }>;
    dateUncertain: Array<{ title: string; url: string; sourceName: string }>;
    lateDiscovered: Array<{ title: string; url: string; publishedAt: string }>;
    totals: { fetched: number; inWindow: number; afterDedupe: number; clusters: number; assessed: number; selected: number };
  };
};
export type PublicStorySection = "topStories" | "competitive" | "signals" | "risk" | "opportunities";
export type PublicStory = {
  id: string;
  headline: string;
  dek: string;
  sections: PublicStorySection[];
  categories: string[];
  whatHappened: string;
  whyItMatters: string;
  recommendedAction?: string;
  confidence: number;
  score: number;
  publishedAt: string;
  isUpdate: boolean;
  sources: Array<{ id: string; name: string; url: string; type: "primary" | "press" | "community"; primary: boolean }>;
};

const RISK_CATEGORIES = new Set(["safety", "outage", "regulation"]);
const COMPETITIVE_CATEGORIES = new Set(["funding", "acquisition", "partnership", "competitive"]);
const SIGNALS_CATEGORIES = new Set(["tooling", "culture"]);
const COMMUNITY_SOURCE_KINDS = new Set(["hn", "lobsters", "reddit", "bluesky"]);

/** Deterministic ontology-category -> masthead-section heuristic; `topStories` is always included. */
function sectionsFor(categories: string[]): PublicStorySection[] {
  const sections = new Set<PublicStorySection>(["topStories"]);
  for (const category of categories) {
    if (RISK_CATEGORIES.has(category)) sections.add("risk");
    if (COMPETITIVE_CATEGORIES.has(category)) sections.add("competitive");
    if (SIGNALS_CATEGORIES.has(category)) sections.add("signals");
  }
  return [...sections];
}

/** First sentence of `text`, capped, as a magazine-subhead stand-in — no model call, purely deterministic. */
function dekFrom(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return firstSentence.length > 140 ? `${firstSentence.slice(0, 137)}...` : firstSentence;
}

function sourcesForCluster(cluster: Cluster | undefined, canonicalUrl: string): PublicStory["sources"] {
  if (!cluster || cluster.sourceIds.length === 0) return [{ id: "unknown", name: "unknown", url: canonicalUrl, type: "community", primary: true }];
  return cluster.sourceIds.map((sourceId, index) => {
    const kind = cluster.sourceKinds[index] ?? cluster.sourceKinds[0];
    const type: PublicStory["sources"][number]["type"] = index === 0 ? "primary" : kind && COMMUNITY_SOURCE_KINDS.has(kind) ? "community" : "press";
    return { id: sourceId, name: sourceId, url: canonicalUrl, type, primary: index === 0 };
  });
}

export function buildPublicIssue(
  issue: Issue,
  srcIdMap: Record<string, string>,
  clusters: Cluster[],
  rankedTopStories: RankedStory[],
  coverage: CoverageRow[],
  dateUncertainSample: DateUncertainSample[],
  degraded: boolean,
  windowStart: string,
  windowEnd: string,
  generatedAt: string,
  totals: { fetched: number; inWindow: number; afterDedupe: number; clusters: number; assessed: number; selected: number },
): PublicIssue {
  const clusterById = new Map(clusters.map((cluster) => [cluster.srcId, cluster]));
  const rankedById = new Map(rankedTopStories.map((story) => [story.srcId, story]));
  const headlineById = new Map(issue.topStories.map((story) => [story.srcId, story.headline]));
  const actionById = new Map(issue.recommendedActions.map((action) => [action.srcId, action.action]));

  const stories: PublicStory[] = issue.topStories.map((story) => {
    const cluster = clusterById.get(story.srcId);
    const ranked = rankedById.get(story.srcId);
    const canonicalUrl = srcIdMap[story.srcId] ?? cluster?.canonicalUrl ?? "";
    return {
      id: story.srcId,
      headline: story.headline,
      dek: dekFrom(story.whyItMatters),
      sections: sectionsFor(story.categories),
      categories: story.categories,
      whatHappened: story.body,
      whyItMatters: story.whyItMatters,
      recommendedAction: actionById.get(story.srcId),
      confidence: ranked?.confidence ?? 0,
      score: ranked?.score ?? 0,
      publishedAt: cluster?.publishedAt ?? generatedAt,
      isUpdate: cluster?.isUpdate ?? false,
      sources: sourcesForCluster(cluster, canonicalUrl),
    };
  });

  const brief = issue.briefs.map((item) => ({
    headline: headlineById.get(item.srcId) ?? dekFrom(item.text),
    text: item.text,
    storyId: headlineById.has(item.srcId) ? item.srcId : undefined,
  }));

  const ourMove = issue.recommendedActions.map((action) => {
    const story = issue.topStories.find((entry) => entry.srcId === action.srcId);
    return { action: action.action, rationale: story?.whyItMatters ?? "", storyIds: [action.srcId] };
  });

  const lighterSide = issue.lighterSide.map((item) => {
    const cluster = clusterById.get(item.srcId);
    return {
      text: item.text,
      url: srcIdMap[item.srcId] ?? cluster?.canonicalUrl ?? "",
      sourceName: cluster?.sourceIds[0] ?? "unknown",
      kind: "post" as const,
    };
  });

  return {
    version: 1,
    date: issue.issueDateEt,
    generatedAt,
    window: { start: windowStart, end: windowEnd },
    degraded,
    brief,
    stories,
    ourMove,
    lighterSide,
    coverage: {
      sourcesChecked: coverage.map((row) => ({ id: row.sourceId, name: row.sourceId, ok: row.ok, error: row.error ?? undefined, itemCount: row.itemCount })),
      dateUncertain: dateUncertainSample.map((item) => ({ title: item.title, url: item.url, sourceName: item.sourceId })),
      lateDiscovered: [],
      totals,
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SECTION_TITLES: Record<Issue["sectionOrder"][number], string> = {
  topStories: "Top Stories",
  recommendedActions: "Recommended Actions",
  briefs: "Also Notable",
  lighterSide: "The Lighter Side",
};

function renderMarkdownSection(kind: Issue["sectionOrder"][number], issue: Issue, srcIdMap: Record<string, string>): string {
  const title = `## ${SECTION_TITLES[kind]}`;
  if (kind === "topStories") {
    if (issue.topStories.length === 0) return `${title}\n\nNo qualifying stories today.`;
    const body = issue.topStories
      .map((story, index) => {
        const link = srcIdMap[story.srcId] ?? "";
        return [
          `### ${index + 1}. ${story.headline}`,
          story.body,
          `**Why it matters:** ${story.whyItMatters}`,
          story.categories.length ? `Categories: ${story.categories.join(", ")}` : "",
          `Source: [${story.srcId}](${link})`,
        ]
          .filter(Boolean)
          .join("\n\n");
      })
      .join("\n\n");
    return `${title}\n\n${body}`;
  }
  if (kind === "recommendedActions") {
    if (issue.recommendedActions.length === 0) return `${title}\n\nNone today.`;
    const body = issue.recommendedActions.map((action) => `1. ${action.action} (${action.srcId})`).join("\n");
    return `${title}\n\n${body}`;
  }
  if (kind === "briefs") {
    if (issue.briefs.length === 0) return `${title}\n\nNone today.`;
    const body = issue.briefs.map((brief) => `- ${brief.text} (${brief.srcId})`).join("\n");
    return `${title}\n\n${body}`;
  }
  if (issue.lighterSide.length === 0) return `${title}\n\nQuiet day for memes.`;
  const body = issue.lighterSide.map((item) => `- ${item.text} (${item.srcId})`).join("\n");
  return `${title}\n\n${body}`;
}

function renderHtmlSection(kind: Issue["sectionOrder"][number], issue: Issue, srcIdMap: Record<string, string>): string {
  const title = `<h2>${escapeHtml(SECTION_TITLES[kind])}</h2>`;
  if (kind === "topStories") {
    if (issue.topStories.length === 0) return `${title}<p>No qualifying stories today.</p>`;
    const body = issue.topStories
      .map((story, index) => {
        const link = srcIdMap[story.srcId] ?? "#";
        return `<article><h3>${index + 1}. ${escapeHtml(story.headline)}</h3><p>${escapeHtml(story.body)}</p><p><strong>Why it matters:</strong> ${escapeHtml(story.whyItMatters)}</p>${story.categories.length ? `<p class="categories">${escapeHtml(story.categories.join(", "))}</p>` : ""}<p><a href="${escapeHtml(link)}" rel="noopener noreferrer">${escapeHtml(story.srcId)}</a></p></article>`;
      })
      .join("\n");
    return `${title}${body}`;
  }
  if (kind === "recommendedActions") {
    if (issue.recommendedActions.length === 0) return `${title}<p>None today.</p>`;
    const items = issue.recommendedActions.map((action) => `<li>${escapeHtml(action.action)} (${escapeHtml(action.srcId)})</li>`).join("");
    return `${title}<ol>${items}</ol>`;
  }
  if (kind === "briefs") {
    if (issue.briefs.length === 0) return `${title}<p>None today.</p>`;
    const items = issue.briefs.map((brief) => `<li>${escapeHtml(brief.text)} (${escapeHtml(brief.srcId)})</li>`).join("");
    return `${title}<ul>${items}</ul>`;
  }
  if (issue.lighterSide.length === 0) return `${title}<p>Quiet day for memes.</p>`;
  const items = issue.lighterSide.map((item) => `<li>${escapeHtml(item.text)} (${escapeHtml(item.srcId)})</li>`).join("");
  return `${title}<ul>${items}</ul>`;
}

function renderCoverageMarkdown(coverage: CoverageRow[]): string {
  const rows = coverage
    .map((row) => `| ${row.sourceId} | ${row.kind} | ${row.ok ? "ok" : "failed"} | ${row.itemCount} | ${row.retried ? "yes" : "no"} | ${row.error ?? ""} |`)
    .join("\n");
  return `## Source Coverage\n\n| Source | Kind | Status | Items | Retried | Error |\n| --- | --- | --- | --- | --- | --- |\n${rows}`;
}

function renderCoverageHtml(coverage: CoverageRow[]): string {
  const rows = coverage
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.sourceId)}</td><td>${escapeHtml(row.kind)}</td><td>${row.ok ? "ok" : "failed"}</td><td>${row.itemCount}</td><td>${row.retried ? "yes" : "no"}</td><td>${escapeHtml(row.error ?? "")}</td></tr>`,
    )
    .join("");
  return `<h2>Source Coverage</h2><table><thead><tr><th>Source</th><th>Kind</th><th>Status</th><th>Items</th><th>Retried</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderIssue(
  issue: Issue,
  srcIdMap: Record<string, string>,
  coverage: CoverageRow[],
  dateUncertainSample: DateUncertainSample[],
  degraded: boolean,
  criticalFailed: boolean,
  publicIssueInputs: {
    clusters: Cluster[];
    rankedTopStories: RankedStory[];
    windowStart: string;
    windowEnd: string;
    generatedAt: string;
    totals: { fetched: number; inWindow: number; afterDedupe: number; clusters: number; assessed: number; selected: number };
  },
): RenderOutput {
  const bodyMarkdown = issue.sectionOrder.map((kind) => renderMarkdownSection(kind, issue, srcIdMap)).join("\n\n");
  const dateUncertainMarkdown = dateUncertainSample.length
    ? `## Date-Uncertain Appendix\n\n${dateUncertainSample.map((item) => `- ${item.title} (${item.sourceId}) — ${item.url}`).join("\n")}`
    : "## Date-Uncertain Appendix\n\nNone.";
  const markdown = [
    `# ${issue.headline}`,
    `_${issue.issueDateEt} — The Smithers Signal_`,
    issue.intro,
    bodyMarkdown,
    `## Coverage Statement\n\n${issue.coverageStatement}${degraded ? " (degraded: one or more sources failed today.)" : ""}${criticalFailed ? " **A critical source failed.**" : ""}`,
    renderCoverageMarkdown(coverage),
    dateUncertainMarkdown,
  ].join("\n\n");

  const bodyHtml = issue.sectionOrder.map((kind) => renderHtmlSection(kind, issue, srcIdMap)).join("\n");
  const dateUncertainHtml = dateUncertainSample.length
    ? `<h2>Date-Uncertain Appendix</h2><ul>${dateUncertainSample.map((item) => `<li>${escapeHtml(item.title)} (${escapeHtml(item.sourceId)}) — <a href="${escapeHtml(item.url)}">link</a></li>`).join("")}</ul>`
    : "<h2>Date-Uncertain Appendix</h2><p>None.</p>";
  const html = `<article class="smithers-signal"><header><h1>${escapeHtml(issue.headline)}</h1><p class="issue-date">${escapeHtml(issue.issueDateEt)} — The Smithers Signal</p><p class="intro">${escapeHtml(issue.intro)}</p></header>${bodyHtml}<section class="coverage-statement"><h2>Coverage Statement</h2><p>${escapeHtml(issue.coverageStatement)}${degraded ? " (degraded: one or more sources failed today.)" : ""}${criticalFailed ? " <strong>A critical source failed.</strong>" : ""}</p></section>${renderCoverageHtml(coverage)}${dateUncertainHtml}</article>`;

  const publicIssue = buildPublicIssue(
    issue,
    srcIdMap,
    publicIssueInputs.clusters,
    publicIssueInputs.rankedTopStories,
    coverage,
    dateUncertainSample,
    degraded,
    publicIssueInputs.windowStart,
    publicIssueInputs.windowEnd,
    publicIssueInputs.generatedAt,
    publicIssueInputs.totals,
  );
  const issueJson = JSON.stringify(publicIssue, null, 2);

  return {
    issueJson,
    markdown,
    html,
    storyCount: issue.topStories.length,
    coverageAppendixPresent: true,
    summary: `Rendered ${issue.topStories.length} top stories, ${issue.recommendedActions.length} actions, ${issue.briefs.length} briefs, ${issue.lighterSide.length} lighter-side items.`,
  };
}

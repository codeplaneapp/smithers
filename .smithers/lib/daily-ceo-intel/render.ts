import type { CoverageRow, DateUncertainSample, Issue, RenderOutput } from "./schemas";

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

  const issueJson = JSON.stringify(
    {
      ...issue,
      links: srcIdMap,
      coverage,
      dateUncertainSample,
      degraded,
      criticalFailed,
    },
    null,
    2,
  );

  return {
    issueJson,
    markdown,
    html,
    storyCount: issue.topStories.length,
    coverageAppendixPresent: true,
    summary: `Rendered ${issue.topStories.length} top stories, ${issue.recommendedActions.length} actions, ${issue.briefs.length} briefs, ${issue.lighterSide.length} lighter-side items.`,
  };
}

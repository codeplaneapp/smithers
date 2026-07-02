import { workflowUiThemeCss } from "@smithers-orchestrator/gateway-ui/styleguide-css";
import type { ReviewRunOutput } from "smithers-workflows/lib/open-code-review";
import { extractDiffAssets } from "../diffs/extractDiffAssets";
import { renderFallbackDiffHtml } from "../diffs/renderFallbackDiffHtml";
import { renderPierreFileDiff } from "../diffs/renderPierreFileDiff";
import type { ChangedFile } from "./changedFileSchema";
import { escapeHtml } from "./escapeHtml";
import { mermaidRuntime } from "./mermaidRuntime";
import { renderOverviewChart } from "./renderOverviewChart";
import { renderProse } from "./renderProse";
import type { Story, StoryBlock } from "./storySchema";

type ReviewComment = ReviewRunOutput["comments"][number];

const OPEN_DIFF_MAX_CHURN = 300;
// Above this churn the diff is rendered by the plain fallback renderer (which
// truncates) instead of the fully highlighted Pierre renderer.
const PIERRE_MAX_CHURN = 5_000;

const css = `
${workflowUiThemeCss}
body { margin: 0; font-size: 16px; line-height: 1.65; color: var(--text); background: var(--bg); }
main { max-width: 1080px; margin: 0 auto; padding: 24px 24px 96px; }
a { color: var(--brand); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .diff, pre { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; }
header.page { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 24px 28px; margin-bottom: 24px; }
header.page h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.3; }
header.page .synopsis { margin: 0 0 16px; color: var(--muted); max-width: 75ch; }
.overview-chart { display: block; width: 100%; max-width: 780px; margin: 4px 0 16px; }
.chart-label { font-size: 12px; fill: var(--muted); }
.chart-count { font-size: 11px; fill: var(--text-faint); }
.chart-add { fill: var(--success); }
.chart-del { fill: var(--danger); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { font-size: 12.5px; background: var(--hover-subtle); border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; color: var(--muted); }
.chip strong { color: var(--text); font-weight: 600; }
.chip.add strong { color: var(--success); }
.chip.del strong { color: var(--danger); }
.controls { margin-left: auto; display: flex; gap: 8px; }
.controls button { font: 12.5px inherit; border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 2px 10px; cursor: pointer; color: var(--muted); }
.controls button:hover { background: var(--hover); }
section.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px 28px; margin-bottom: 24px; }
section.panel h2 { margin: 0 0 12px; font-size: 18px; }
section.panel ol { margin: 0; padding-left: 24px; }
section.panel li { margin: 4px 0; }
.finding-link .loc { color: var(--muted); font-size: 13px; }
section.chapter { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 24px 28px; margin-bottom: 24px; }
section.chapter > h2 { margin: 0 0 16px; font-size: 21px; }
section.chapter > h2 .num { color: var(--text-faint); font-weight: 500; margin-right: 8px; }
.prose { max-width: 80ch; }
.prose p { margin: 12px 0; }
.prose h3, .prose h4, .prose h5, .prose h6 { margin: 20px 0 8px; }
.prose ul { margin: 8px 0; padding-left: 24px; }
.prose blockquote { margin: 12px 0; padding: 4px 16px; border-left: 4px solid var(--border); color: var(--muted); }
.prose pre.prose-code { background: var(--hover-subtle); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; overflow-x: auto; font-size: 13px; line-height: 1.5; }
.prose code { background: var(--inline-code-bg); border-radius: 4px; padding: 1px 5px; font-size: 0.9em; }
.prose pre.prose-code code { background: none; padding: 0; }
figure.diagram { margin: 20px 0; padding: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); overflow-x: auto; text-align: center; }
figure.diagram figcaption { margin-top: 8px; font-size: 13px; color: var(--muted); text-align: center; }
figure.diagram pre.mermaid { text-align: left; margin: 0; display: flex; justify-content: center; }
article.file { border: 1px solid var(--border); border-radius: 8px; margin: 20px 0; overflow: hidden; }
article.file .file-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 14px; background: var(--hover-subtle); border-bottom: 1px solid var(--border); }
article.file .file-head code { font-size: 13.5px; font-weight: 600; word-break: break-all; }
.badge { font-size: 11.5px; border-radius: 999px; padding: 1px 9px; border: 1px solid transparent; text-transform: uppercase; letter-spacing: 0.03em; }
.badge.added { background: color-mix(in srgb, var(--success) 14%, var(--surface)); color: var(--success); border-color: color-mix(in srgb, var(--success) 35%, var(--border)); }
.badge.deleted { background: color-mix(in srgb, var(--danger) 12%, var(--surface)); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); }
.badge.modified { background: color-mix(in srgb, var(--brand) 12%, var(--surface)); color: var(--brand); border-color: color-mix(in srgb, var(--brand) 35%, var(--border)); }
.badge.renamed, .badge.binary { background: color-mix(in srgb, var(--brand) 10%, var(--surface)); color: var(--brand); border-color: color-mix(in srgb, var(--brand) 30%, var(--border)); }
.stat { font-size: 12.5px; color: var(--muted); }
.stat .plus { color: var(--success); font-weight: 600; }
.stat .minus { color: var(--danger); font-weight: 600; }
.not-reviewed { font-size: 11.5px; color: var(--text-faint); margin-left: auto; }
article.file .intro { margin: 10px 14px; color: var(--text); font-size: 14.5px; max-width: 80ch; }
aside.finding { margin: 12px 14px; border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border)); border-left: 4px solid var(--warning); background: color-mix(in srgb, var(--warning) 12%, var(--surface)); border-radius: 6px; padding: 10px 14px; }
aside.finding .loc { font-size: 12px; color: var(--warning); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
aside.finding p { margin: 6px 0; white-space: pre-wrap; }
aside.finding pre { margin: 8px 0 2px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; font-size: 12.5px; line-height: 1.5; }
aside.finding .pre-label { font-size: 11.5px; color: var(--muted); margin-top: 8px; }
article.file details { border-top: 1px solid var(--border); }
article.file details summary { cursor: pointer; padding: 8px 14px; font-size: 13px; color: var(--muted); user-select: none; }
article.file details summary:hover { background: var(--hover); }
article.file .pierre-diff pre[data-diff] { margin: 0; border-radius: 0; }
.diff { width: 100%; border-collapse: collapse; font-size: 12.5px; line-height: 1.55; }
.diff td { padding: 0 8px; vertical-align: top; }
.diff td.ln { width: 1%; min-width: 42px; text-align: right; color: var(--text-faint); user-select: none; border-right: 1px solid var(--border); }
.diff td.code { white-space: pre-wrap; word-break: break-all; }
.diff tr.add { background: color-mix(in srgb, var(--success) 10%, var(--surface)); }
.diff tr.add td.ln { background: color-mix(in srgb, var(--success) 16%, var(--surface)); }
.diff tr.del { background: color-mix(in srgb, var(--danger) 9%, var(--surface)); }
.diff tr.del td.ln { background: color-mix(in srgb, var(--danger) 14%, var(--surface)); }
.diff tr.hunk { background: color-mix(in srgb, var(--brand) 10%, var(--surface)); color: var(--muted); }
.diff tr.hunk td.code { padding: 4px 8px; }
.diff-note { color: var(--muted); font-size: 13.5px; padding: 8px 14px; margin: 0; }
footer { text-align: center; color: var(--text-faint); font-size: 13px; }
`.trim();

const script = `
function setAllDiffs(open) {
  for (const d of document.querySelectorAll("article.file details")) d.open = open;
}
document.getElementById("expand-all").addEventListener("click", () => setAllDiffs(true));
document.getElementById("collapse-all").addEventListener("click", () => setAllDiffs(false));
`.trim();

function statChip(insertions: number, deletions: number): string {
  return `<span class="stat"><span class="plus">+${insertions}</span> <span class="minus">−${deletions}</span></span>`;
}

function findingCard(comment: ReviewComment): string {
  const loc =
    comment.startLine > 0
      ? `Lines ${comment.startLine}${comment.endLine > comment.startLine ? `–${comment.endLine}` : ""}`
      : "Review finding";
  const existing = comment.existingCode
    ? `<div class="pre-label">Existing code</div><pre>${escapeHtml(comment.existingCode)}</pre>`
    : "";
  const suggestion = comment.suggestionCode
    ? `<div class="pre-label">Suggested</div><pre>${escapeHtml(comment.suggestionCode)}</pre>`
    : "";
  return `<aside class="finding"><div class="loc">${escapeHtml(loc)}</div><p>${escapeHtml(comment.content)}</p>${existing}${suggestion}</aside>`;
}

function diffSection(
  file: ChangedFile,
  intro: string,
  comments: ReviewComment[],
  anchor: string,
  diffBody: string,
): string {
  const open = file.insertions + file.deletions <= OPEN_DIFF_MAX_CHURN;
  const notReviewed =
    !file.reviewed && file.excludeReason ? `<span class="not-reviewed">not agent-reviewed (${escapeHtml(file.excludeReason)})</span>` : "";
  return [
    `<article class="file" id="${anchor}">`,
    `<div class="file-head"><code>${escapeHtml(file.path)}</code><span class="badge ${escapeHtml(file.status)}">${escapeHtml(file.status)}</span>${statChip(file.insertions, file.deletions)}${notReviewed}</div>`,
    intro ? `<p class="intro">${escapeHtml(intro)}</p>` : "",
    ...comments.map(findingCard),
    `<details${open ? " open" : ""}><summary>Diff (+${file.insertions} −${file.deletions})</summary><div class="pierre-diff">${diffBody}</div></details>`,
    `</article>`,
  ].join("");
}

function diagramSection(block: StoryBlock, index: number): string {
  return [
    `<figure class="diagram" id="diagram-${index}">`,
    `<pre class="mermaid">${escapeHtml(block.mermaid)}</pre>`,
    block.title ? `<figcaption>${escapeHtml(block.title)}</figcaption>` : "",
    `</figure>`,
  ].join("");
}

/**
 * Render every file's diff with @pierre/diffs (syntax highlighting,
 * word-level diffs, line numbers), hoisting the shared style/sprite assets so
 * the page carries them once. Binary, oversized, and unparseable diffs fall
 * back to the plain renderer.
 */
async function renderDiffBodies(
  files: ChangedFile[],
  diffStyle: "unified" | "split",
): Promise<{ bodies: Map<string, string>; sprite: string; styles: string[] }> {
  const bodies = new Map<string, string>();
  const styles = new Set<string>();
  let sprite = "";
  await Promise.all(
    files.map(async (file) => {
      if (!file.diff.trim() || file.insertions + file.deletions > PIERRE_MAX_CHURN) {
        bodies.set(file.path, renderFallbackDiffHtml(file.diff));
        return;
      }
      try {
        const html = await renderPierreFileDiff({ diff: file.diff, diffStyle });
        const assets = extractDiffAssets(html);
        for (const style of assets.styles) styles.add(style);
        if (!sprite) sprite = assets.sprite;
        bodies.set(file.path, assets.body);
      } catch {
        bodies.set(file.path, renderFallbackDiffHtml(file.diff));
      }
    }),
  );
  return { bodies, sprite, styles: [...styles] };
}

/**
 * Self-contained HTML walkthrough in story form: chapters are streams of
 * prose, diagrams, and diffs, so the explanation IS the document and each
 * diff appears at the point in the story where the reader needs it. Pierre
 * renders the diffs; Mermaid renders narrator diagrams (runtime inlined only
 * when diagrams exist); a deterministic SVG chart shows the change shape.
 * No external assets; opens from file://.
 */
export async function renderWalkthroughHtml(opts: {
  title: string;
  story: Story;
  files: ChangedFile[];
  comments: ReviewComment[];
  repoDir: string;
  mode: string;
  ref: string;
  generatedAt: string;
  diffStyle?: "unified" | "split";
}): Promise<string> {
  const { story, files, comments } = opts;
  const title = opts.title.trim() || story.headline || "Change walkthrough";
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const anchorByPath = new Map(files.map((file, index) => [file.path, `file-${index + 1}`]));
  const commentsByPath = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    commentsByPath.set(comment.path, [...(commentsByPath.get(comment.path) ?? []), comment]);
  }

  const { bodies, sprite, styles } = await renderDiffBodies(files, opts.diffStyle ?? "unified");

  const totalInsertions = files.reduce((sum, file) => sum + file.insertions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const hasDiagrams = story.chapters.some((chapter) => chapter.blocks.some((block) => block.kind === "diagram"));

  const chips = [
    `<span class="chip">repo <strong>${escapeHtml(opts.repoDir)}</strong></span>`,
    `<span class="chip">target <strong>${escapeHtml(opts.mode)}${opts.ref && opts.ref !== "workspace" ? ` ${escapeHtml(opts.ref)}` : ""}</strong></span>`,
    `<span class="chip"><strong>${files.length}</strong> file(s)</span>`,
    `<span class="chip add"><strong>+${totalInsertions}</strong></span>`,
    `<span class="chip del"><strong>−${totalDeletions}</strong></span>`,
    `<span class="chip">findings <strong>${comments.length}</strong></span>`,
    `<span class="chip">generated <strong>${escapeHtml(opts.generatedAt)}</strong></span>`,
  ].join("");

  const findingsIndex =
    comments.length > 0
      ? `<section class="panel"><h2>Review findings (${comments.length})</h2><ol>${comments
          .map((comment) => {
            const anchor = anchorByPath.get(comment.path) ?? "";
            const loc = comment.startLine > 0 ? `:${comment.startLine}` : "";
            const summary = comment.content.split("\n")[0];
            return `<li class="finding-link"><a href="#${anchor}"><code>${escapeHtml(comment.path)}</code><span class="loc">${escapeHtml(loc)}</span></a> ${escapeHtml(summary)}</li>`;
          })
          .join("")}</ol></section>`
      : "";

  const toc =
    story.chapters.length > 0
      ? `<section class="panel"><h2>Chapters</h2><ol>${story.chapters
          .map((chapter, index) => {
            const diffCount = chapter.blocks.filter((block) => block.kind === "diff").length;
            return `<li><a href="#ch-${index + 1}">${escapeHtml(chapter.title)}</a> <span class="stat">(${diffCount} file(s))</span></li>`;
          })
          .join("")}</ol></section>`
      : `<section class="panel"><h2>No changes detected</h2><p>The review target has no changed files.</p></section>`;

  let diagramIndex = 0;
  const chapters = story.chapters
    .map((chapter, index) => {
      const blocks = chapter.blocks
        .map((block) => {
          if (block.kind === "diff") {
            const file = fileByPath.get(block.path);
            if (!file) return "";
            return diffSection(
              file,
              block.intro,
              commentsByPath.get(block.path) ?? [],
              anchorByPath.get(block.path) ?? "",
              bodies.get(block.path) ?? renderFallbackDiffHtml(file.diff),
            );
          }
          if (block.kind === "diagram") {
            diagramIndex += 1;
            return diagramSection(block, diagramIndex);
          }
          return `<div class="prose">${renderProse(block.text)}</div>`;
        })
        .join("");
      return [
        `<section class="chapter" id="ch-${index + 1}">`,
        `<h2><span class="num">${index + 1}</span>${escapeHtml(chapter.title)}</h2>`,
        blocks,
        `</section>`,
      ].join("");
    })
    .join("");

  const mermaidScripts = hasDiagrams
    ? [
        `<script>${mermaidRuntime()}</script>`,
        `<script>mermaid.initialize({ startOnLoad: true, securityLevel: "strict", theme: "neutral" });</script>`,
      ]
    : [];

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${css}</style>`,
    ...styles,
    `</head>`,
    `<body>`,
    sprite,
    `<main>`,
    `<header class="page">`,
    `<h1>${escapeHtml(title)}</h1>`,
    story.synopsis ? `<p class="synopsis">${escapeHtml(story.synopsis)}</p>` : "",
    renderOverviewChart(files),
    `<div class="chips">${chips}<span class="controls"><button id="expand-all" type="button">Expand all diffs</button><button id="collapse-all" type="button">Collapse all diffs</button></span></div>`,
    `</header>`,
    findingsIndex,
    toc,
    chapters,
    `<footer>Generated by smithers review.</footer>`,
    `</main>`,
    `<script>${script}</script>`,
    ...mermaidScripts,
    `</body>`,
    `</html>`,
  ].join("\n");
}

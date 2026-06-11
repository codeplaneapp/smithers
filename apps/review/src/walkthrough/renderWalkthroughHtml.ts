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
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #1f2328; background: #f6f8fa; }
main { max-width: 1080px; margin: 0 auto; padding: 24px 24px 96px; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
code, .diff, pre { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; }
header.page { background: #fff; border: 1px solid #d1d9e0; border-radius: 12px; padding: 24px 28px; margin-bottom: 24px; }
header.page h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.3; }
header.page .synopsis { margin: 0 0 16px; color: #59636e; max-width: 75ch; }
.overview-chart { display: block; width: 100%; max-width: 780px; margin: 4px 0 16px; }
.chart-label { font-size: 12px; fill: #59636e; }
.chart-count { font-size: 11px; fill: #8c959f; }
.chart-add { fill: #2da44e; }
.chart-del { fill: #cf222e; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { font-size: 12.5px; background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 999px; padding: 2px 10px; color: #59636e; }
.chip strong { color: #1f2328; font-weight: 600; }
.chip.add strong { color: #1a7f37; }
.chip.del strong { color: #cf222e; }
.controls { margin-left: auto; display: flex; gap: 8px; }
.controls button { font: 12.5px inherit; border: 1px solid #d1d9e0; background: #fff; border-radius: 6px; padding: 2px 10px; cursor: pointer; color: #59636e; }
.controls button:hover { background: #f6f8fa; }
section.panel { background: #fff; border: 1px solid #d1d9e0; border-radius: 12px; padding: 20px 28px; margin-bottom: 24px; }
section.panel h2 { margin: 0 0 12px; font-size: 18px; }
section.panel ol { margin: 0; padding-left: 24px; }
section.panel li { margin: 4px 0; }
.finding-link .loc { color: #59636e; font-size: 13px; }
section.chapter { background: #fff; border: 1px solid #d1d9e0; border-radius: 12px; padding: 24px 28px; margin-bottom: 24px; }
section.chapter > h2 { margin: 0 0 16px; font-size: 21px; }
section.chapter > h2 .num { color: #8c959f; font-weight: 500; margin-right: 8px; }
.prose { max-width: 80ch; }
.prose p { margin: 12px 0; }
.prose h3, .prose h4, .prose h5, .prose h6 { margin: 20px 0 8px; }
.prose ul { margin: 8px 0; padding-left: 24px; }
.prose blockquote { margin: 12px 0; padding: 4px 16px; border-left: 4px solid #d1d9e0; color: #59636e; }
.prose pre.prose-code { background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 8px; padding: 12px 14px; overflow-x: auto; font-size: 13px; line-height: 1.5; }
.prose code { background: #f0f2f4; border-radius: 4px; padding: 1px 5px; font-size: 0.9em; }
.prose pre.prose-code code { background: none; padding: 0; }
figure.diagram { margin: 20px 0; padding: 16px; border: 1px solid #d1d9e0; border-radius: 8px; background: #fff; overflow-x: auto; text-align: center; }
figure.diagram figcaption { margin-top: 8px; font-size: 13px; color: #59636e; text-align: center; }
figure.diagram pre.mermaid { text-align: left; margin: 0; display: flex; justify-content: center; }
article.file { border: 1px solid #d1d9e0; border-radius: 8px; margin: 20px 0; overflow: hidden; }
article.file .file-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 14px; background: #f6f8fa; border-bottom: 1px solid #d1d9e0; }
article.file .file-head code { font-size: 13.5px; font-weight: 600; word-break: break-all; }
.badge { font-size: 11.5px; border-radius: 999px; padding: 1px 9px; border: 1px solid transparent; text-transform: uppercase; letter-spacing: 0.03em; }
.badge.added { background: #dafbe1; color: #1a7f37; border-color: #aceebb; }
.badge.deleted { background: #ffebe9; color: #cf222e; border-color: #ffcecb; }
.badge.modified { background: #ddf4ff; color: #0969da; border-color: #b6e3ff; }
.badge.renamed, .badge.binary { background: #fbefff; color: #8250df; border-color: #ecd8ff; }
.stat { font-size: 12.5px; color: #59636e; }
.stat .plus { color: #1a7f37; font-weight: 600; }
.stat .minus { color: #cf222e; font-weight: 600; }
.not-reviewed { font-size: 11.5px; color: #8c959f; margin-left: auto; }
article.file .intro { margin: 10px 14px; color: #36404a; font-size: 14.5px; max-width: 80ch; }
aside.finding { margin: 12px 14px; border: 1px solid #d4a72c66; border-left: 4px solid #bf8700; background: #fff8c5; border-radius: 6px; padding: 10px 14px; }
aside.finding .loc { font-size: 12px; color: #7d4e00; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
aside.finding p { margin: 6px 0; white-space: pre-wrap; }
aside.finding pre { margin: 8px 0 2px; padding: 10px 12px; background: #fff; border: 1px solid #d1d9e0; border-radius: 6px; overflow-x: auto; font-size: 12.5px; line-height: 1.5; }
aside.finding .pre-label { font-size: 11.5px; color: #59636e; margin-top: 8px; }
article.file details { border-top: 1px solid #d1d9e0; }
article.file details summary { cursor: pointer; padding: 8px 14px; font-size: 13px; color: #59636e; user-select: none; }
article.file details summary:hover { background: #f6f8fa; }
article.file .pierre-diff pre[data-diff] { margin: 0; border-radius: 0; }
.diff { width: 100%; border-collapse: collapse; font-size: 12.5px; line-height: 1.55; }
.diff td { padding: 0 8px; vertical-align: top; }
.diff td.ln { width: 1%; min-width: 42px; text-align: right; color: #8c959f; user-select: none; border-right: 1px solid #eaeef2; }
.diff td.code { white-space: pre-wrap; word-break: break-all; }
.diff tr.add { background: #e6ffec; }
.diff tr.add td.ln { background: #ccffd8; }
.diff tr.del { background: #ffebe9; }
.diff tr.del td.ln { background: #ffd7d5; }
.diff tr.hunk { background: #ddf4ff; color: #59636e; }
.diff tr.hunk td.code { padding: 4px 8px; }
.diff-note { color: #59636e; font-size: 13.5px; padding: 8px 14px; margin: 0; }
footer { text-align: center; color: #8c959f; font-size: 13px; }
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

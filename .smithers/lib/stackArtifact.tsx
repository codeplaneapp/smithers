/** @jsxImportSource react */
import { renderToStaticMarkup } from "react-dom/server";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DiffHunks,
  KpiStat,
  Markdown,
  SectionHeader,
  SmithersUiStyles,
  StatusPill,
  parseUnifiedFile,
} from "smithers-orchestrator/ui";
import { z } from "zod/v4";
import type { CheckResult } from "./stackedShip";
import { artifactFileName } from "./stackedShip";

/**
 * Story-form HTML artifacts for stacked-ship PRs: one self-contained page per
 * PR revision plus a stack index. Rendered with React static markup over the
 * shared UI library; diffs go through the pierre SSR path when available and
 * fall back to SSR DiffHunks. Spec: .smithers/specs/stacked-ship-workflow.md
 */

// ── Story schema ─────────────────────────────────────────────────────────────

export const stackStorySchema = z.object({
  headline: z.string().min(8).max(200),
  synopsis: z.string().min(20),
  chapters: z
    .array(
      z.object({
        title: z.string().min(3),
        prose: z.string().min(10),
        diffPaths: z.array(z.string()).default([]),
      }),
    )
    .min(1)
    .max(12),
});
export type StackStory = z.infer<typeof stackStorySchema>;

/**
 * Validate an agent-produced story and drop diffPath references that do not
 * exist in the actual diff, so a hallucinated path can never break rendering.
 * Returns null when the story is unusable (callers fall back).
 */
export function normalizeStory(raw: unknown, availablePaths: string[]): StackStory | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  // Persisted rows JSON-stringify nested arrays; coerce before validating.
  if (typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).chapters === "string") {
    try {
      value = {
        ...(value as Record<string, unknown>),
        chapters: JSON.parse((value as Record<string, unknown>).chapters as string),
      };
    } catch {
      return null;
    }
  }
  const parsed = stackStorySchema.safeParse(value);
  if (!parsed.success) return null;
  const known = new Set(availablePaths);
  return {
    ...parsed.data,
    chapters: parsed.data.chapters.map((chapter) => ({
      ...chapter,
      diffPaths: chapter.diffPaths.filter((path) => known.has(path)),
    })),
  };
}

/** Deterministic story when the story agent fails: one chapter over the stat. */
export function fallbackStory(options: { slug: string; title: string; changedPaths: string[] }): StackStory {
  const paths = options.changedPaths;
  return {
    headline: options.title,
    synopsis:
      "Automatically generated walkthrough for " +
      options.slug +
      ": the narrator step produced no usable story, so this artifact lists the change mechanically. " +
      paths.length +
      " file(s) changed.",
    chapters: [
      {
        title: "The change",
        prose: paths.length
          ? "Files touched by this PR:\n\n" + paths.map((path) => "- `" + path + "`").join("\n")
          : "The diff is empty.",
        diffPaths: paths,
      },
    ],
  };
}

// ── Diff splitting ───────────────────────────────────────────────────────────

export type FileDiff = { path: string; text: string };

/** Split one `jj diff --git` / `git diff` document into per-file patches. */
export function splitUnifiedDiff(diffText: string): FileDiff[] {
  const out: FileDiff[] = [];
  const lines = (diffText ?? "").split("\n");
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) pushFile(out, current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) pushFile(out, current);
  return out;
}

function pushFile(out: FileDiff[], lines: string[]) {
  const text = lines.join("\n");
  const header = lines[0] ?? "";
  let path = "";
  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      path = line.slice("+++ b/".length).trim();
      break;
    }
    if (line.startsWith("--- a/") && !path) path = line.slice("--- a/".length).trim();
  }
  if (!path) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
    path = match ? match[2].trim() : "unknown";
  }
  out.push({ path, text });
}

// ── Rendering ────────────────────────────────────────────────────────────────

export type PierreRenderers = {
  render: (args: { diff: string }) => Promise<string>;
  extract: (html: string) => { sprite: string; styles: string[]; body: string };
};

/** Loaded lazily so environments without the review package still render. */
export async function loadPierre(): Promise<PierreRenderers | null> {
  try {
    const mod = await import("@smithers-orchestrator/review/diffs");
    return { render: mod.renderPierreFileDiff, extract: mod.extractDiffAssets };
  } catch {
    return null;
  }
}

const ARTIFACT_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; background: var(--sui-background, Canvas); }
.ship-page { max-width: 980px; margin: 0 auto; padding: 24px 20px 80px; display: flex; flex-direction: column; gap: 16px; }
.ship-kpis { display: flex; gap: 12px; flex-wrap: wrap; }
.ship-diff-details { border: 1px solid var(--sui-border, #8883); border-radius: 8px; padding: 0 12px 8px; overflow-x: auto; }
.ship-diff-details > summary { cursor: pointer; padding: 10px 0; font: 500 13px/1.4 ui-monospace, monospace; }
.pierre-diff { overflow-x: auto; }
.ship-reasons { margin: 8px 0 0; padding-left: 20px; }
.ship-index-table { width: 100%; border-collapse: collapse; }
.ship-index-table td, .ship-index-table th { padding: 8px 10px; text-align: left; border-bottom: 1px solid #8883; font-size: 13px; }
`;

function documentShell(title: string, bodyHtml: string, extraStyles: string[]): string {
  return (
    "<!doctype html>\n" +
    '<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>' +
    "<title>" +
    escapeText(title) +
    "</title>" +
    extraStyles.join("") +
    "<style>" +
    ARTIFACT_CSS +
    "</style></head><body>" +
    bodyHtml +
    "</body></html>\n"
  );
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type PrArtifactOptions = {
  missionTitle: string;
  stackKey: string;
  slug: string;
  title: string;
  revision: number;
  story: StackStory;
  diffText: string;
  hygiene: { ok: boolean; reasons: string[] };
  checks: CheckResult[];
  approvalState: string;
  generatedAt: string;
  pierre?: PierreRenderers | null;
};

/**
 * Render one PR revision to a fully self-contained HTML document. Every
 * chapter interleaves prose (markdown) with the diffs it references; files no
 * chapter references land in a trailing "Everything else" section so the
 * artifact always shows the complete change.
 */
export async function renderPrArtifactHtml(options: PrArtifactOptions): Promise<string> {
  const files = splitUnifiedDiff(options.diffText);
  const pierre = options.pierre === undefined ? await loadPierre() : options.pierre;

  const rendered = new Map<string, { body: string; styles: string[] }>();
  for (const file of files) {
    rendered.set(file.path, await renderOneFile(file, pierre));
  }

  const seenStyles = new Set<string>();
  const hoistedStyles: string[] = [];
  for (const entry of rendered.values()) {
    for (const style of entry.styles) {
      if (seenStyles.has(style)) continue;
      seenStyles.add(style);
      hoistedStyles.push(style);
    }
  }

  const referenced = new Set(options.story.chapters.flatMap((chapter) => chapter.diffPaths));
  const leftovers = files.filter((file) => !referenced.has(file.path));

  const diffBlock = (path: string) => {
    const entry = rendered.get(path);
    if (!entry) return null;
    return (
      <details className="ship-diff-details" open={files.length <= 8} key={"diff-" + path}>
        <summary>{path}</summary>
        <div dangerouslySetInnerHTML={{ __html: entry.body }} />
      </details>
    );
  };

  const body = renderToStaticMarkup(
    <div className="ship-page">
      <SmithersUiStyles withTheme />
      <SectionHeader
        eyebrow={options.missionTitle + " / " + options.stackKey}
        title={options.story.headline}
        actions={<StatusPill status={options.approvalState} label={options.approvalState} />}
      />
      <div className="ship-kpis">
        <KpiStat label="PR" value={options.slug} hint={"revision " + options.revision} />
        <KpiStat label="Files" value={String(files.length)} />
        <KpiStat
          label="Hygiene"
          value={options.hygiene.ok ? "clean" : "failing"}
          hint={
            options.hygiene.ok ? "one change, in scope, checks green" : options.hygiene.reasons.length + " issue(s)"
          }
        />
        <KpiStat label="Generated" value={options.generatedAt} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{options.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Markdown content={options.story.synopsis} />
        </CardContent>
      </Card>
      {options.hygiene.ok ? null : (
        <Card>
          <CardHeader>
            <CardTitle>Hygiene failures</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="ship-reasons">
              {options.hygiene.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {options.story.chapters.map((chapter, index) => (
        <Card key={"chapter-" + index}>
          <CardHeader>
            <CardTitle>{chapter.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <Markdown content={chapter.prose} />
            {chapter.diffPaths.map(diffBlock)}
          </CardContent>
        </Card>
      ))}
      {leftovers.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Everything else</CardTitle>
          </CardHeader>
          <CardContent>{leftovers.map((file) => diffBlock(file.path))}</CardContent>
        </Card>
      ) : null}
      {options.checks.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Checks</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="ship-reasons">
              {options.checks.map((check, index) => (
                <li key={index}>
                  {(check.exitCode === 0 ? "PASS " : "FAIL(" + check.exitCode + ") ") + check.command}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>,
  );

  return documentShell(options.slug + " r" + options.revision + " · " + options.missionTitle, body, hoistedStyles);
}

async function renderOneFile(
  file: FileDiff,
  pierre: PierreRenderers | null,
): Promise<{ body: string; styles: string[] }> {
  const lineCount = file.text.split("\n").length;
  if (pierre && lineCount <= 5_000) {
    try {
      const html = await pierre.render({ diff: file.text });
      const assets = pierre.extract(html);
      return {
        body: '<div class="pierre-diff">' + assets.sprite + assets.body + "</div>",
        styles: assets.styles,
      };
    } catch {
      // fall through to DiffHunks
    }
  }
  const parsed = parseUnifiedFile(file.text, { path: file.path });
  return { body: renderToStaticMarkup(<DiffHunks file={parsed} revealed={lineCount <= 2_000} />), styles: [] };
}

// ── Stack index ──────────────────────────────────────────────────────────────

export type StackIndexRow = {
  slug: string;
  title: string;
  revision: number;
  phase: string;
  headline: string;
};

export function renderStackIndexHtml(options: {
  missionTitle: string;
  stackKey: string;
  generatedAt: string;
  rows: StackIndexRow[];
}): string {
  const body = renderToStaticMarkup(
    <div className="ship-page">
      <SmithersUiStyles withTheme />
      <SectionHeader eyebrow={"stacked-ship / " + options.stackKey} title={options.missionTitle} />
      <Card>
        <CardHeader>
          <CardTitle>The stack, bottom to top</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="ship-index-table">
            <thead>
              <tr>
                <th>#</th>
                <th>PR</th>
                <th>Story</th>
                <th>Phase</th>
                <th>Artifact</th>
              </tr>
            </thead>
            <tbody>
              {options.rows.map((row, index) => (
                <tr key={row.slug}>
                  <td>{index + 1}</td>
                  <td>{row.slug}</td>
                  <td>{row.headline || row.title}</td>
                  <td>
                    <StatusPill status={row.phase} label={row.phase} />
                  </td>
                  <td>
                    <a href={artifactFileName(row.slug, row.revision)}>{artifactFileName(row.slug, row.revision)}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <p>Generated {options.generatedAt}</p>
    </div>,
  );
  return documentShell(options.missionTitle + " · stack index", body, []);
}

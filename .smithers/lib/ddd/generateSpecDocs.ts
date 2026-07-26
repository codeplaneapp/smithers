import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { dddRoot } from "./dddRoot.ts";
import type { Feature } from "./featuresSchema.ts";
import { validateFeatures } from "./validateFeatures.ts";

/**
 * Derives one spec doc per feature from .smithers/spec/features.json into
 * .smithers/spec/content/features/<id>.md. The features directory is fully
 * regenerated on every run (stale docs for removed ids are deleted). Derived
 * docs are never hand-edited; change features.json instead.
 * .smithers/spec/content/overview.md is the editable product overview and is
 * never touched here.
 */
const statusLabels: Record<string, string> = {
  fixed: "Fixed",
  partial: "Partial",
  broken: "Broken",
  "missing-tests": "Missing tests",
  missing: "Missing",
};

const tierLabels: Record<string, string> = {
  feature: "Feature",
  platform: "Platform",
  reference: "Reference",
};

const cliCommandPhrases = new Set([
  "workflow run",
  "workflow list",
  "up",
  "ps",
  "inspect",
  "output",
  "retry-task",
  "resume",
  "init",
  "monitor",
  "migrate",
  "gateway",
  "ui",
]);

function codeSpan(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function escapeMarkdownText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function escapeMarkdownHeading(value: string): string {
  return escapeMarkdownText(value).replace(/^#+\s*/, "");
}

function escapeLinkLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeLinkDestination(value: string): string {
  return value.replaceAll(" ", "%20").replaceAll(")", "%29");
}

function formatCommandList(value: string): string | null {
  const trailingPeriod = value.trim().endsWith(".");
  const text = value.trim().replace(/\.$/, "");
  const items = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length < 2) return null;
  const canFormat = items.every((item) => cliCommandPhrases.has(item) || /^[A-Za-z][A-Za-z0-9:-]*$/.test(item));
  if (!canFormat) return null;
  return `${items.map(codeSpan).join(", ")}${trailingPeriod ? "." : ""}`;
}

type InlineReplacement = { start: number; end: number; text: string };

function commandPipeReplacements(value: string): InlineReplacement[] {
  const replacements: InlineReplacement[] = [];
  const pattern = /\bsmithers\s+([A-Za-z0-9-]+)\s+([A-Za-z0-9-]+(?:\|[A-Za-z0-9-]+)+)\b/g;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    const group = match[1] ?? "";
    const alternatives = (match[2] ?? "").split("|").filter(Boolean);
    if (!group || alternatives.length < 2) continue;
    replacements.push({
      start,
      end: start + (match[0] ?? "").length,
      text: alternatives.map((alternative) => codeSpan(`smithers ${group} ${alternative}`)).join(" | "),
    });
  }
  return replacements;
}

function codeRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const patterns = [
    /\b(?:bun|npm|pnpm|yarn|deno|cargo|go|pytest|mvn|gradle|dotnet|make|just)\s+(?:-[A-Za-z]\s+[^\s,;:)]+\s+)?[A-Za-z0-9:_./-]+(?:\s+(?:--?[A-Za-z0-9_-]+|[A-Za-z0-9._/-]+))*/g,
    /\bpython\s+-m\s+pytest(?:\s+[A-Za-z0-9._/-]+)*/g,
    /\bsmithers\s+workflow\s+run\s+[A-Za-z0-9._~:/?#@!$&'*+=-]+/g,
    /\bsmithers(?:\s+(?:init|workflow|list|run|up|ps|inspect|output|monitor|migrate|gateway|ui|agent|add|remove|retry-task|resume|approve|deny|alerts|cron|memory|usage|down|cancel|hijack|logs|events|openapi|optimize|eval|scores|snapshot|snapshots|restore|replay|fork|rewind|signal|why|human|ask|chat|token|tree|docs|docs-full))+/g,
    /(?:^|(?<=[\s(]))(?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._~:/?#@!$&'*+=-]+)+/g,
    /\b(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|Makefile|Justfile|Dockerfile)\b/g,
    /\bfeatures\.json\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const rawStart = match.index ?? 0;
      const raw = match[0] ?? "";
      const leadingSpace = raw.match(/^\s/) ? 1 : 0;
      const start = rawStart + leadingSpace;
      let end = rawStart + raw.length;
      while (end > start && /[.,;:]$/.test(value.slice(end - 1, end))) end -= 1;
      if (start < end) ranges.push({ start, end });
    }
  }
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function formatInline(value: string): string {
  const commandList = formatCommandList(value);
  if (commandList) return commandList;
  const special = commandPipeReplacements(value);
  const ranges = codeRanges(value);
  const replacements: InlineReplacement[] = [
    ...special,
    ...ranges.map(
      (range): InlineReplacement => ({
        start: range.start,
        end: range.end,
        text: codeSpan(value.slice(range.start, range.end)),
      }),
    ),
  ].sort((left, right) => left.start - right.start || right.end - left.end);
  const nonOverlapping: InlineReplacement[] = [];
  for (const replacement of replacements) {
    const previous = nonOverlapping.at(-1);
    if (previous && replacement.start < previous.end) continue;
    nonOverlapping.push(replacement);
  }
  if (nonOverlapping.length === 0) return escapeMarkdownText(value);
  let cursor = 0;
  let out = "";
  for (const replacement of nonOverlapping) {
    out += escapeMarkdownText(value.slice(cursor, replacement.start));
    out += replacement.text;
    cursor = replacement.end;
  }
  out += escapeMarkdownText(value.slice(cursor));
  return out;
}

function compactBlocks(blocks: string[]): string {
  return blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n");
}

function section(title: string, items: string[] | undefined): string {
  const list = (items ?? []).filter(Boolean);
  if (list.length === 0) return "";
  return `## ${title}\n\n${list.map((item) => `- ${formatInline(item)}`).join("\n")}`;
}

function capabilitiesSection(feature: Feature): string {
  const caps = feature.capabilities ?? [];
  if (caps.length === 0) return "";
  const body = caps
    .map((cap) => {
      const badge = cap.status ? ` (${statusLabels[cap.status] ?? cap.status})` : "";
      return `### ${escapeMarkdownHeading(cap.title)}${badge}\n\n${formatInline(cap.detail)}`;
    })
    .join("\n\n");
  return `## Capabilities\n\n${body}`;
}

function endpointsSection(feature: Feature): string {
  const eps = feature.endpoints ?? [];
  if (eps.length === 0) return "";
  const rows = eps
    .map((ep) => {
      const link = ep.doc ? ` ([docs](${escapeLinkDestination(ep.doc)}))` : "";
      const note = ep.note ? ` - ${formatInline(ep.note)}` : "";
      return `- ${codeSpan(`${ep.method} ${ep.path}`)}${note}${link}`;
    })
    .join("\n");
  return `## Endpoints and commands\n\n${rows}`;
}

function linksSection(feature: Feature): string {
  const links = feature.links ?? [];
  if (links.length === 0) return "";
  const rows = links
    .map((link) => `- [${escapeLinkLabel(link.label)}](${escapeLinkDestination(link.href)})`)
    .join("\n");
  return `## Related docs\n\n${rows}`;
}

function featureDoc(feature: Feature): string {
  const tier = feature.tier ?? "feature";
  const metaBits = [
    `**Status:** ${statusLabels[feature.status] ?? feature.status}`,
    `**Priority:** ${feature.priority.toUpperCase()}`,
    `**Owner:** ${escapeMarkdownText(feature.owner)}`,
    feature.group ? `**Group:** ${escapeMarkdownText(feature.group)}` : "",
    tier !== "feature" ? `**Tier:** ${tierLabels[tier] ?? tier}` : "",
  ].filter(Boolean);

  return compactBlocks([
    `# ${escapeMarkdownHeading(feature.title)}`,
    `> ${metaBits.join(" | ")}`,
    formatInline(feature.summary),
    feature.userValue ? `## What you can do\n\n${formatInline(feature.userValue)}` : "",
    capabilitiesSection(feature),
    endpointsSection(feature),
    linksSection(feature),
    section("Test cases", feature.tests),
    section("Observability", feature.observability),
    section("Debugging", feature.debug),
    section("Architecture", feature.architecture),
    section("Evidence", feature.evidence),
    section("Fixes and diffs", [...(feature.changes ?? []), ...(feature.diffHints ?? [])]),
    section("Open gaps", feature.missing),
  ]);
}

export function generateSpecDocs(root: string = dddRoot()): number {
  const features = validateFeatures(root, { allowMissing: true });
  const contentDir = resolve(root, ".smithers/spec/content");
  const featuresDir = resolve(contentDir, "features");

  mkdirSync(contentDir, { recursive: true });
  rmSync(featuresDir, { recursive: true, force: true });
  mkdirSync(featuresDir, { recursive: true });

  for (const feature of features) {
    writeFileSync(resolve(featuresDir, `${feature.id}.md`), `${featureDoc(feature)}\n`);
  }
  return readdirSync(featuresDir).length;
}

if (import.meta.main) {
  try {
    const count = generateSpecDocs();
    console.log(`ddd spec-docs: generated ${count} derived feature docs -> .smithers/spec/content/features/`);
  } catch (error) {
    console.error(`ddd spec-docs failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

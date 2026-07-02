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

function section(title: string, items: string[] | undefined): string {
  const list = (items ?? []).filter(Boolean);
  if (list.length === 0) return `## ${title}\n\n_None recorded yet._\n`;
  return `## ${title}\n\n${list.map((item) => `- ${item}`).join("\n")}\n`;
}

function capabilitiesSection(feature: Feature): string {
  const caps = feature.capabilities ?? [];
  if (caps.length === 0) return "";
  const body = caps
    .map((cap) => {
      const badge = cap.status ? ` _(${statusLabels[cap.status] ?? cap.status})_` : "";
      return `### ${cap.title}${badge}\n\n${cap.detail}\n`;
    })
    .join("\n");
  return `## Capabilities\n\n${body}\n`;
}

function endpointsSection(feature: Feature): string {
  const eps = feature.endpoints ?? [];
  if (eps.length === 0) return "";
  const rows = eps
    .map((ep) => {
      const link = ep.doc ? ` ([docs](${ep.doc}))` : "";
      const note = ep.note ? ` (${ep.note})` : "";
      return `- \`${ep.method} ${ep.path}\`${note}${link}`;
    })
    .join("\n");
  return `## Endpoints & commands\n\n${rows}\n\n`;
}

function linksSection(feature: Feature): string {
  const links = feature.links ?? [];
  if (links.length === 0) return "";
  const rows = links.map((link) => `- [${link.label}](${link.href})`).join("\n");
  return `## Related docs\n\n${rows}\n\n`;
}

function featureDoc(feature: Feature): string {
  const tier = feature.tier ?? "feature";
  const metaBits = [
    `**Status:** ${statusLabels[feature.status] ?? feature.status}`,
    `**Priority:** ${feature.priority.toUpperCase()}`,
    `**Owner:** ${feature.owner}`,
    feature.group ? `**Group:** ${feature.group}` : "",
    tier !== "feature" ? `**Tier:** ${tierLabels[tier] ?? tier}` : "",
  ].filter(Boolean);

  return [
    `# ${feature.title}`,
    "",
    `> ${metaBits.join(" · ")}`,
    "",
    feature.userValue ? `**What you can do:** ${feature.userValue}\n` : "",
    feature.summary,
    "",
    capabilitiesSection(feature),
    endpointsSection(feature),
    linksSection(feature),
    section("Test cases", feature.tests),
    section("Observability", feature.observability),
    section("Debugging", feature.debug),
    section("Architecture", feature.architecture),
    section("Fixes & diffs", [...(feature.changes ?? []), ...(feature.diffHints ?? [])]),
    section("Open gaps", feature.missing),
  ].join("\n");
}

export function generateSpecDocs(root: string = dddRoot()): number {
  const features = validateFeatures(root);
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

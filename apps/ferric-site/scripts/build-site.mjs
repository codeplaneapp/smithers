/**
 * Builds site/index.html from template.html.
 *
 * Every code excerpt on ferric.smithers.sh is extracted verbatim from the real
 * campaign source at build time, so the site can never drift from what it
 * documents. Placeholders in the template:
 *
 *   <!--CODE <file-key> <start> <end> "caption"-->        a line-numbered excerpt
 *   <!--CODE <file-key> <start> <end> "caption" hl=1,2--> ... with highlighted lines
 *   <!--ANCHOR <file-key> "<needle>" <before> <after> "caption" [hl-needle="..."]-->
 *                                                        an excerpt located by CONTENT
 *   <!--STAT <name>-->                                   computed facts
 *
 * Prefer ANCHOR over CODE: it survives edits to the source that shift line
 * numbers, which is exactly what silently rotted this page once already.
 *
 * Usage: node scripts/build-site.mjs [--out <path>]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const smithersRoot = join(here, "..", "..", "..");
const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const OUT = argVal("--out", join(here, "..", "site", "index.html"));

/** Short keys the template cites, mapped to real paths. */
export const FILE_KEYS = {
  workflow: ".smithers/workflows/react-rust-port.tsx",
  slice: ".smithers/components/ferric/Slice.tsx",
  portcampaign: ".smithers/components/ferric/PortCampaign.tsx",
  foundation: ".smithers/components/ferric/FoundationAndBudget.tsx",
  queueparse: ".smithers/components/ferric/QueueParse.tsx",
  gate: ".smithers/components/ferric/CampaignGate.tsx",
  gates: ".smithers/components/ferric/ferricGates.ts",
  publish: ".smithers/components/ferric/PublishPipeline.tsx",
  shell: ".smithers/components/ferric/ferricShell.ts",
  ledger: ".smithers/components/ferric/ferricLedger.ts",
  m0: ".smithers/components/ferric/PhaseM0.tsx",
  implementPrompt: ".smithers/prompts/ferric-slice-implement.mdx",
  reviewPrompt: ".smithers/prompts/ferric-slice-review.mdx",
};

const sources = Object.fromEntries(
  Object.entries(FILE_KEYS).map(([k, rel]) => [
    k,
    { rel, lines: readFileSync(join(smithersRoot, rel), "utf8").split("\n") },
  ]),
);

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function render(key, start, end, caption, hl) {
  const src = sources[key];
  if (!src) throw new Error(`build-site: unknown file key "${key}"`);
  const hlSet = new Set(hl ?? []);
  const rows = src.lines
    .slice(start - 1, end)
    .map((text, i) => {
      const n = start + i;
      const on = hlSet.has(n);
      return (
        `<div class="sui-diff-line ${on ? "sui-diff-add" : "sui-diff-context"}">` +
        `<span class="sui-diff-ln">${n}</span>` +
        `<span class="sui-diff-sign">${on ? "+" : " "}</span>` +
        `<span class="sui-diff-text">${esc(text)}</span></div>`
      );
    })
    .join("");
  return (
    `<div class="sui-diff" data-slot="diff-hunks">` +
    `<div class="sui-diff-hunk-head"><span class="sui-diff-hunk-gutter">···</span>` +
    `<span class="sui-diff-hunk-header">@@ ${esc(src.rel)} L${start}–L${end} · ${esc(caption)} @@</span></div>` +
    rows +
    `</div>`
  );
}

/** Find a needle's 1-based line, or fail loudly rather than emit a wrong excerpt. */
function findLine(key, needle) {
  const src = sources[key];
  if (!src) throw new Error(`build-site: unknown file key "${key}"`);
  const idx = src.lines.findIndex((l) => l.includes(needle));
  if (idx < 0) {
    throw new Error(
      `build-site: anchor not found in ${src.rel}: ${JSON.stringify(needle)} — the source moved; fix the template.`,
    );
  }
  return idx + 1;
}

let html = readFileSync(join(here, "..", "template.html"), "utf8");

// Content-anchored excerpts (preferred).
html = html.replace(
  /<!--ANCHOR (\w+) "([^"]*)" (\d+) (\d+) "([^"]*)"(?: hl-needle="([^"]*)")?-->/g,
  (_, key, needle, before, after, caption, hlNeedle) => {
    const at = findLine(key, needle);
    const start = Math.max(1, at - Number(before));
    const end = Math.min(sources[key].lines.length, at + Number(after));
    const hl = hlNeedle
      ? hlNeedle.split("||").map((n) => findLine(key, n))
      : [at];
    return render(key, start, end, caption, hl);
  },
);

// Absolute line ranges (only where the range is structural, e.g. a whole file).
html = html.replace(
  /<!--CODE (\w+) (\d+) (\d+) "([^"]*)"(?: hl=([\d,]+))?-->/g,
  (_, key, s, e, caption, hl) =>
    render(key, Number(s), Number(e), caption, hl ? hl.split(",").map(Number) : []),
);

const promptCount = readdirSync(join(smithersRoot, ".smithers/prompts")).filter((f) =>
  f.startsWith("ferric-") && f.endsWith(".mdx"),
).length;
const componentCount = readdirSync(join(smithersRoot, ".smithers/components/ferric")).length;

const STATS = {
  workflowLines: String(sources.workflow.lines.length),
  promptCount: String(promptCount),
  componentCount: String(componentCount),
  gateCount: String(
    (sources.gates.lines.join("\n").match(/^\s{2}"gate-[a-z0-9-]+":/gm) || []).length,
  ),
};

html = html.replace(/<!--STAT (\w+)-->/g, (_, key) => {
  if (!(key in STATS)) throw new Error(`build-site: unknown STAT "${key}"`);
  return STATS[key];
});

const leftovers = html.match(/<!--(CODE|ANCHOR|STAT)[^>]*-->/g);
if (leftovers) throw new Error(`build-site: unresolved placeholders: ${leftovers.join(", ")}`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(
  `build-site: wrote ${OUT} (${(html.length / 1024).toFixed(0)}KB) — ${componentCount} components, ${promptCount} prompts`,
);

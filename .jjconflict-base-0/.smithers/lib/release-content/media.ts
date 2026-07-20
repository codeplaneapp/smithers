import { dirname, join } from "node:path";
import { writeText, writeJson } from "./files";
import type {
  ContentBrief,
  EditedContent,
  MediaAssets,
  MediaAssetKind,
  Probe,
  ReleaseAnalysis,
  ReleaseContentInput,
  ThreadDraft,
} from "./schemas";

// Smithers design tokens, flattened to solid hex for universal SVG rendering.
// Mirrors marketing/<prior>/assets/_cards.html.
const TOKENS = {
  bg: "#0C0E16",
  surface: "#141826",
  border: "#232A3A",
  textPrimary: "#E7E9EE",
  textSecondary: "#9CA3B4",
  textTertiary: "#6B7280",
  accent: "#4C8DFF",
  accentFill: "#16233C",
  accentStroke: "#2C4A86",
  success: "#34D399",
  warning: "#FBBF24",
  danger: "#F87171",
  fontSans: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontMono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
} as const;

const W = 1600;
const H = 900;
const PAD_X = 96;
const CONTENT_W = W - PAD_X * 2;

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripDecoration(text: string): string {
  let out = text.trim();
  // leading thread numbering like "1/8 " or "1. "
  out = out.replace(/^\s*\d+\s*\/\s*\d+\s*/, "").replace(/^\s*\d+[.)]\s+/, "");
  // markdown code emphasis renders as literal backticks on a card; drop it
  out = out.replace(/`/g, "");
  // pictographic emoji + variation selectors
  try {
    out = out.replace(/[\p{Extended_Pictographic}️]/gu, "");
  } catch {
    // older runtimes without unicode property escapes: leave emojis in place
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function wrap(text: string, maxChars: number, maxLines = 5): string[] {
  const words = stripDecoration(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[.,;:]$/, "")}…`;
    return kept;
  }
  return lines;
}

function extractCommand(...candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const backticked = candidate.match(/`([^`]*bunx smithers[^`]*)`/i);
    if (backticked) return backticked[1].trim();
    const bare = candidate.match(/\b(bunx smithers-orchestrator [a-z][\w -]*)/i);
    if (bare) return bare[1].trim();
    const anyBacktick = candidate.match(/`(\$?\s*[a-z][\w./-]+ [^`]+)`/);
    if (anyBacktick) return anyBacktick[1].replace(/^\$\s*/, "").trim();
  }
  return null;
}

function extractUrls(...candidates: Array<string | undefined>): string[] {
  const urls = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const matches = candidate.match(/https?:\/\/[^\s)>\]]+/g);
    for (const url of matches ?? []) urls.add(url.replace(/[.,]$/, ""));
  }
  return [...urls];
}

function tweetLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function classifyMediaKind(suggestion: string, index: number): MediaAssetKind {
  const value = (suggestion ?? "").toLowerCase();
  if (index === 0 || value.includes("hero")) return "hero";
  if (value.includes("changelog") || value.includes("proof") || value.includes("cta")) {
    return "changelog";
  }
  if (
    value.includes("diagram") ||
    value.includes("before/after") ||
    value.includes("before / after") ||
    value.includes("schematic")
  ) {
    return "diagram";
  }
  if (
    value.includes("terminal") ||
    value.includes("screenshot") ||
    value.includes("cli output") ||
    value.includes("console")
  ) {
    return "terminal";
  }
  return "capability";
}

function textBlock(params: {
  lines: string[];
  x: number;
  y: number;
  size: number;
  lineHeight: number;
  fill: string;
  weight?: number;
  mono?: boolean;
  letterSpacing?: number;
  anchor?: "start" | "middle" | "end";
}): string {
  const { lines, x, y, size, lineHeight, fill, weight, mono, letterSpacing, anchor } = params;
  if (lines.length === 0) return "";
  const family = mono ? TOKENS.fontMono : TOKENS.fontSans;
  const attrs = [
    `font-size="${size}"`,
    `font-family="${family}"`,
    `fill="${fill}"`,
    weight ? `font-weight="${weight}"` : "",
    letterSpacing ? `letter-spacing="${letterSpacing}"` : "",
    anchor ? `text-anchor="${anchor}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const tspans = lines
    .map((line, i) => `<tspan x="${x}" y="${y + i * lineHeight}">${esc(line)}</tspan>`)
    .join("");
  return `<text ${attrs}>${tspans}</text>`;
}

function promptBox(command: string, y: number): { svg: string; height: number } {
  const height = 84;
  const svg = `
  <rect x="${PAD_X}" y="${y}" width="${CONTENT_W}" height="${height}" rx="14" fill="#000000" stroke="${TOKENS.accentStroke}"/>
  <text x="${PAD_X + 32}" y="${y + 54}" font-size="30" font-family="${TOKENS.fontMono}" fill="${TOKENS.textPrimary}"><tspan fill="${TOKENS.accent}">$ </tspan>${esc(command)}</text>`;
  return { svg, height };
}

function footer(version: string): string {
  return `
  <rect x="${PAD_X}" y="${H - 88}" width="16" height="16" rx="4" fill="${TOKENS.accent}"/>
  <text x="${PAD_X + 28}" y="${H - 74}" font-size="26" font-family="${TOKENS.fontSans}" fill="${TOKENS.textTertiary}">smithers.sh</text>
  <text x="${W - PAD_X}" y="${H - 74}" font-size="26" font-family="${TOKENS.fontMono}" fill="${TOKENS.textTertiary}" text-anchor="end">${esc(version)}</text>`;
}

function frame(inner: string, version: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="80%" cy="0%" r="70%">
      <stop offset="0%" stop-color="${TOKENS.accent}" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="${TOKENS.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${TOKENS.bg}"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
${inner}
${footer(version)}
</svg>
`;
}

type CardSpec = {
  kind: MediaAssetKind;
  version: string;
  kicker: string;
  headline: string;
  sub: string;
  command: string | null;
  bullets: string[];
  links: string[];
  caption: string | null;
};

function renderTitleCard(spec: CardSpec): string {
  const isHero = spec.kind === "hero";
  const parts: string[] = [];
  let y = 156;

  parts.push(
    textBlock({
      lines: [spec.kicker.toUpperCase()],
      x: PAD_X,
      y,
      size: 22,
      lineHeight: 22,
      fill: TOKENS.accent,
      mono: true,
      letterSpacing: 5,
    }),
  );
  y += 66;

  const headlineSize = isHero ? 84 : 60;
  const headlineLH = isHero ? 90 : 68;
  const headlineLines = wrap(spec.headline, isHero ? 24 : 32, isHero ? 3 : 3);
  y += headlineSize;
  parts.push(
    textBlock({
      lines: headlineLines,
      x: PAD_X,
      y,
      size: headlineSize,
      lineHeight: headlineLH,
      fill: TOKENS.textPrimary,
      weight: 800,
    }),
  );
  y += (headlineLines.length - 1) * headlineLH + 56;

  if (spec.sub) {
    const subLines = wrap(spec.sub, 62, 4);
    parts.push(
      textBlock({
        lines: subLines,
        x: PAD_X,
        y,
        size: 32,
        lineHeight: 46,
        fill: TOKENS.textSecondary,
      }),
    );
    y += (subLines.length - 1) * 46 + 64;
  }

  if (spec.kind === "diagram") {
    const before = "before";
    const after = "after";
    const boxW = 360;
    const gap = 60;
    const rowY = y;
    parts.push(`
  <rect x="${PAD_X}" y="${rowY}" width="${boxW}" height="84" rx="12" fill="${TOKENS.surface}" stroke="${TOKENS.border}"/>
  <text x="${PAD_X + boxW / 2}" y="${rowY + 52}" font-size="30" font-family="${TOKENS.fontMono}" fill="${TOKENS.textSecondary}" text-anchor="middle">${esc(before)}</text>
  <text x="${PAD_X + boxW + gap / 2}" y="${rowY + 54}" font-size="40" fill="${TOKENS.textTertiary}" text-anchor="middle">→</text>
  <rect x="${PAD_X + boxW + gap}" y="${rowY}" width="${boxW}" height="84" rx="12" fill="${TOKENS.accentFill}" stroke="${TOKENS.accentStroke}"/>
  <text x="${PAD_X + boxW + gap + boxW / 2}" y="${rowY + 52}" font-size="30" font-family="${TOKENS.fontMono}" fill="${TOKENS.accent}" text-anchor="middle">${esc(after)}</text>`);
    y += 84 + 48;
  }

  if (spec.bullets.length > 0) {
    let bulletY = y;
    for (const bullet of spec.bullets.slice(0, 5)) {
      const lines = wrap(bullet, 70, 2);
      parts.push(`<text x="${PAD_X}" y="${bulletY + 30}" font-size="30" fill="${TOKENS.accent}">▪</text>`);
      parts.push(
        textBlock({
          lines,
          x: PAD_X + 40,
          y: bulletY + 30,
          size: 30,
          lineHeight: 40,
          fill: TOKENS.textSecondary,
        }),
      );
      bulletY += 28 + lines.length * 40;
    }
    y = bulletY + 16;
  }

  if (spec.command && y < H - 240) {
    const { svg, height } = promptBox(spec.command, y);
    parts.push(svg);
    y += height + 24;
  }

  if (spec.links.length > 0) {
    const links = spec.links.slice(0, 3);
    // keep links clear of the footer band regardless of how far content ran
    const linkY = Math.min(y + 28, H - 116 - (links.length - 1) * 42);
    parts.push(
      textBlock({
        lines: links,
        x: PAD_X,
        y: linkY,
        size: 28,
        lineHeight: 42,
        fill: TOKENS.accent,
        mono: true,
      }),
    );
  }

  return frame(parts.join("\n"), spec.version);
}

function renderTerminalCard(spec: CardSpec): string {
  const parts: string[] = [];
  parts.push(
    textBlock({
      lines: [spec.kicker.toUpperCase()],
      x: PAD_X,
      y: 156,
      size: 22,
      lineHeight: 22,
      fill: TOKENS.accent,
      mono: true,
      letterSpacing: 5,
    }),
  );

  const winX = PAD_X;
  const winY = 220;
  const winW = CONTENT_W;
  const winH = 440;
  parts.push(`
  <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="16" fill="${TOKENS.surface}" stroke="${TOKENS.border}"/>
  <rect x="${winX}" y="${winY}" width="${winW}" height="64" rx="16" fill="#0A0D14"/>
  <rect x="${winX}" y="${winY + 40}" width="${winW}" height="24" fill="${TOKENS.surface}"/>
  <circle cx="${winX + 34}" cy="${winY + 32}" r="9" fill="${TOKENS.danger}"/>
  <circle cx="${winX + 64}" cy="${winY + 32}" r="9" fill="${TOKENS.warning}"/>
  <circle cx="${winX + 94}" cy="${winY + 32}" r="9" fill="${TOKENS.success}"/>
  <text x="${winX + winW / 2}" y="${winY + 40}" font-size="24" font-family="${TOKENS.fontMono}" fill="${TOKENS.textTertiary}" text-anchor="middle">smithers</text>`);

  const command = spec.command ?? "bunx smithers-orchestrator --help";
  const commandLines = wrap(command, 64, 3);
  parts.push(
    `<text font-size="32" font-family="${TOKENS.fontMono}" fill="${TOKENS.textPrimary}">` +
      commandLines
        .map(
          (line, i) =>
            `<tspan x="${winX + 40}" y="${winY + 140 + i * 48}">${i === 0 ? `<tspan fill="${TOKENS.accent}">$ </tspan>` : ""}${esc(line)}</tspan>`,
        )
        .join("") +
      `</text>`,
  );

  parts.push(
    textBlock({
      lines: ["▸ run this command to capture real output"],
      x: winX + 40,
      y: winY + 140 + commandLines.length * 48 + 30,
      size: 26,
      lineHeight: 38,
      fill: TOKENS.textTertiary,
      mono: true,
    }),
  );

  parts.push(
    textBlock({
      lines: wrap(
        spec.sub || "Generated placeholder card. Replace with a real terminal capture before posting.",
        72,
        2,
      ),
      x: PAD_X,
      y: winY + winH + 60,
      size: 28,
      lineHeight: 40,
      fill: TOKENS.textSecondary,
    }),
  );

  return frame(parts.join("\n"), spec.version);
}

function buildSpec(params: {
  kind: MediaAssetKind;
  tweetText: string;
  suggestion: string;
  version: string;
  analysis: ReleaseAnalysis;
  brief: ContentBrief | null | undefined;
  ctaUrl: string;
}): CardSpec {
  const { kind, tweetText, suggestion, version, analysis, brief, ctaUrl } = params;
  const lines = tweetLines(tweetText);
  const headlineFromTweet = lines[0] ? stripDecoration(lines[0]) : "";
  const subFromTweet = lines.slice(1).join(" ");
  const command = extractCommand(suggestion, tweetText, brief?.cta);
  const urls = extractUrls(tweetText);

  if (kind === "hero") {
    return {
      kind,
      version,
      kicker: `Smithers · v${version}`,
      headline: brief?.headline || analysis.title || headlineFromTweet || `Smithers ${version}`,
      sub: brief?.subheadline || analysis.oneSentenceSummary || subFromTweet,
      command,
      bullets: [],
      links: [],
      caption: null,
    };
  }

  if (kind === "changelog") {
    const bullets =
      analysis.userVisibleChanges.length > 0
        ? analysis.userVisibleChanges.slice(0, 4)
        : tweetLines(subFromTweet).slice(0, 4);
    const links = urls.length > 0 ? urls : [ctaUrl, "github.com/smithersai/smithers"];
    return {
      kind,
      version,
      kicker: `Smithers ${version} · changelog`,
      headline: headlineFromTweet || `What shipped in ${version}`,
      sub: "",
      command: null,
      bullets,
      links,
      caption: null,
    };
  }

  return {
    kind,
    version,
    kicker: `Smithers · v${version}`,
    headline: headlineFromTweet || `Smithers ${version}`,
    sub: subFromTweet,
    command,
    bullets: [],
    links: [],
    caption: null,
  };
}

export function renderCardSvg(spec: CardSpec): string {
  return spec.kind === "terminal" ? renderTerminalCard(spec) : renderTitleCard(spec);
}

function pad(index: number): string {
  return String(index).padStart(2, "0");
}

const RASTERIZER_SCRIPT = `// Auto-generated by the release-content workflow.
// Rasterize every *.svg in this folder to a 2x *.png with Playwright (for X/Twitter upload).
// Usage: node <path-to-this-file>
import { readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
let chromium = null;
const bases = [
  here,
  join(here, '..', '..', '..'),
  join(here, '..', '..', '..', 'apps', 'smithers'),
  join(here, '..', '..', '..', 'apps', 'smithers-studio-2'),
];
for (const base of bases) {
  try {
    chromium = createRequire(join(base, 'package.json'))('playwright').chromium;
    break;
  } catch (error) {}
}
if (!chromium) {
  try {
    chromium = (await import('playwright')).chromium;
  } catch (error) {}
}
if (!chromium) {
  console.error('Playwright not found. Run: npm i -D playwright && npx playwright install chromium');
  console.error('Or upload the .svg files directly.');
  process.exit(1);
}
const svgs = readdirSync(here).filter((file) => file.endsWith('.svg'));
if (svgs.length === 0) {
  console.error('No .svg files found in ' + here);
  process.exit(1);
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
for (const file of svgs) {
  await page.goto(pathToFileURL(join(here, file)).href);
  const png = basename(file, '.svg') + '.png';
  await page.screenshot({ path: join(here, png) });
  console.log('shot ' + png);
}
await browser.close();
`;

/**
 * Render a real media card asset for every tweet in the thread, write them next
 * to the thread markdown under marketing/<version>/assets/, and emit a manifest
 * plus a Playwright rasterizer for PNG output. Self-contained and zero-dependency
 * so it runs wherever the .smithers pack is installed.
 */
export function renderMediaAssets(params: {
  input: ReleaseContentInput;
  probe: Probe;
  analysis: ReleaseAnalysis;
  brief?: ContentBrief | null;
  content: EditedContent;
}): MediaAssets {
  const { input, probe, analysis, brief, content } = params;
  const thread: ThreadDraft | null = content.tweetThread;
  const assetDir = join(dirname(probe.threadPath), "assets");

  if (!thread || thread.tweets.length === 0) {
    return {
      generated: false,
      assetDir,
      files: [],
      assets: [],
      captures: [],
      manifestPath: null,
      rasterizerPath: null,
      message: "No tweet thread present; no media assets generated.",
    };
  }

  const root = process.cwd();
  const files: string[] = [];
  const assets: MediaAssets["assets"] = [];
  const captures: MediaAssets["captures"] = [];
  const ctaUrl = brief?.cta || input.tweetThread.ctaUrl;

  thread.tweets.forEach((tweet, position) => {
    const kind = classifyMediaKind(tweet.mediaSuggestion, position);
    const spec = buildSpec({
      kind,
      tweetText: tweet.text,
      suggestion: tweet.mediaSuggestion,
      version: probe.version,
      analysis,
      brief,
      ctaUrl,
    });
    const svg = renderCardSvg(spec);
    const fileName = `tweet-${pad(tweet.index)}-${kind}.svg`;
    const filePath = writeText(root, join(assetDir, fileName), svg);
    files.push(filePath);

    const captureRecommended = kind === "terminal";
    assets.push({
      tweetIndex: tweet.index,
      kind,
      suggestion: tweet.mediaSuggestion,
      file: filePath,
      sibling: `assets/${fileName}`,
      captureRecommended,
      command: spec.command,
    });
    if (captureRecommended) {
      captures.push({
        tweetIndex: tweet.index,
        command: spec.command ?? "(run the documented command)",
        suggestion: tweet.mediaSuggestion,
      });
    }
  });

  const manifestPath = writeJson(root, join(assetDir, "media-manifest.json"), {
    version: probe.version,
    generatedFrom: "release-content workflow render-media",
    assets,
    captures,
  });
  files.push(manifestPath);

  const rasterizerPath = writeText(root, join(assetDir, "render-pngs.mjs"), RASTERIZER_SCRIPT);
  files.push(rasterizerPath);

  const captureNote =
    captures.length > 0
      ? ` ${captures.length} tweet(s) want a real terminal capture (see media-manifest.json).`
      : "";

  return {
    generated: true,
    assetDir,
    files,
    assets,
    captures,
    manifestPath,
    rasterizerPath,
    message:
      `Generated ${assets.length} SVG card(s) in ${assetDir}. ` +
      `Run \`node ${rasterizerPath}\` to rasterize to 2x PNG for upload.${captureNote}`,
  };
}

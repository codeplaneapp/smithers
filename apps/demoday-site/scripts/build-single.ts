// Bundle the built dist/ into ONE self-contained HTML file: CSS, JS, every
// shot, and every narration clip inlined as data URIs. The runtime reads them
// via window.__DECK_ASSETS__ (see src/main.ts).
// Run: bun scripts/build-single.ts [outPath]   (after `pnpm run build`)
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(APP, "dist");
const OUT = process.argv[2] ?? join(APP, "dist-single", "smithers-demoday.html");

function mimeFor(file: string): string {
  if (file.endsWith(".gif")) return "image/gif";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".mp3")) return "audio/mpeg";
  return "application/octet-stream";
}
const dataUri = (path: string) => `data:${mimeFor(path)};base64,${readFileSync(path).toString("base64")}`;

const html = readFileSync(join(DIST, "index.html"), "utf8");
const assetsDir = join(DIST, "assets");
const jsFile = readdirSync(assetsDir).find((f) => f.endsWith(".js"));
const cssFile = readdirSync(assetsDir).find((f) => f.endsWith(".css"));
if (!jsFile || !cssFile) throw new Error("run `pnpm run build` first");
const js = readFileSync(join(assetsDir, jsFile), "utf8").replace(/<\/script>/g, "<\\/script>");
const css = readFileSync(join(assetsDir, cssFile), "utf8");

const shots: Record<string, string> = {};
for (const file of readdirSync(join(DIST, "shots"))) {
  shots[`shots/${file}`] = dataUri(join(DIST, "shots", file));
}
const manifest = JSON.parse(readFileSync(join(DIST, "narration", "manifest.json"), "utf8")) as {
  steps: { file: string }[];
};
const files: Record<string, string> = {};
for (const step of manifest.steps) files[step.file] = dataUri(join(DIST, "narration", step.file));

const head = (html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? "")
  .replace(/<script[\s\S]*?<\/script>/g, "")
  .replace(/<link rel="stylesheet"[^>]*>/g, "");
const assetsJson = JSON.stringify({ shots, narration: { manifest, files } }).replace(/<\/script>/g, "<\\/script>");

const out = `<!doctype html>
<html lang="en">
<head>${head}<style>
${css}
</style></head>
<body>
<div id="app"></div>
<script>window.__DECK_ASSETS__ = ${assetsJson};</script>
<script type="module">
${js}
</script>
</body>
</html>
`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(`${OUT} — ${(out.length / 1e6).toFixed(1)}MB`);

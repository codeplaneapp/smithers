// Build the deployable site assets for https://stereos.smithers.sh.
//
// Everything the page shows is derived here from committed sources, so the page
// cannot drift from the code that produced it:
//
//   site/index.html        page/index.template.html plus the generated flow
//                          diagram, evidence cards, walkthrough, and guard
//                          rules. Walkthrough excerpts are sliced out of the
//                          raw captures by anchor and fail the build if the
//                          anchor is gone.
//   site/live.js           page/live.js, verbatim.
//   site/evidence.js       page/evidence.js, verbatim.
//   site/real-run.js       the raw captures from real/.
//   site/proposed-api.html tab1-source/, verbatim.
//   site/impl.js           the Implementation tab: a React bundle of
//                          page/impl/ built on smthrs/ui, with every source
//                          file tokenized by Shiki for both themes.
//
// Run: node examples/stereos-sandbox-provider/build.mjs
import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "site");
const repoRoot = join(here, "..", "..");
const require = createRequire(import.meta.url);

const read = (...parts) => readFile(join(here, ...parts), "utf8");
const escape = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Slice `count` lines out of a raw capture starting at the line containing
 * `anchor`. The build fails rather than shipping an excerpt that no longer
 * exists, so nothing on the page can be a paraphrase of terminal output.
 */
function excerpt(capture, anchor, count) {
  const lines = capture.split("\n");
  const at = lines.findIndex((line) => line.includes(anchor));
  if (at < 0) throw new Error(`capture no longer contains ${JSON.stringify(anchor)}`);
  return lines.slice(at, at + count).join("\n");
}

// ── the flow diagram ────────────────────────────────────────────────────────

/** One stage box in the horizontal flow. */
const STAGES = [
  ["Visitor", "browser", "muted"],
  ["Guard", "Bun, allowlist", "orange"],
  ["Gateway", "loopback only", "muted"],
  ["Smithers", "<Sandbox>", "blue"],
  ["SSH", "provider seam", "muted"],
  ["stereOS VM", "QEMU/KVM", "green"],
  ["Bun in guest", "child workflow", "green"],
];

/**
 * Lay the stages out left to right with a return path underneath. Inline SVG
 * keeps the diagram sharp, themeable through the page's CSS variables, and free
 * of any runtime dependency.
 */
function flowDiagram() {
  const width = 1140;
  const box = 138;
  const gap = (width - STAGES.length * box) / (STAGES.length - 1);
  const boxes = STAGES.map(([title, sub, tone], index) => {
    const x = index * (box + gap);
    const mid = x + box / 2;
    return `<g><rect x="${x.toFixed(1)}" y="34" width="${box}" height="62" rx="12" fill="var(--card)" stroke="var(--${tone})" stroke-width="1.5"/><text x="${mid.toFixed(1)}" y="60" text-anchor="middle" font-size="13" font-weight="600" fill="var(--ink)">${escape(title)}</text><text x="${mid.toFixed(1)}" y="78" text-anchor="middle" font-size="11" fill="var(--muted)">${escape(sub)}</text></g>`;
  });
  const arrows = STAGES.slice(1).map((_, index) => {
    const from = index * (box + gap) + box + 4;
    const to = (index + 1) * (box + gap) - 4;
    return `<path d="M${from.toFixed(1)} 65 H${to.toFixed(1)}" stroke="var(--line)" stroke-width="1.5" marker-end="url(#arrow)"/>`;
  });
  const last = (STAGES.length - 1) * (box + gap) + box / 2;
  const first = box / 2;
  const back = `<path d="M${last.toFixed(1)} 96 V126 H${first.toFixed(1)} V96" fill="none" stroke="var(--orange)" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#arrow-orange)"/><text x="${(width / 2).toFixed(1)}" y="119" text-anchor="middle" font-size="11" fill="var(--orange)">result JSON written by Bun inside the guest</text>`;
  const defs = `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--line)"/></marker><marker id="arrow-orange" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--orange)"/></marker></defs>`;
  const label =
    "A run travels from the visitor through the guard and the loopback gateway into a Smithers Sandbox, " +
    "over SSH into a stereOS VM where Bun executes the child workflow, and the result returns the same way.";
  return `<div class="scroll"><svg viewBox="0 0 ${width} 140" role="img" aria-label="${escape(label)}">${defs}${boxes.join("")}${arrows.join("")}${back}</svg></div>`;
}

// ── generated page fragments ────────────────────────────────────────────────

/** What the public edge allows, one card per rule. Mirrors demo/guard.ts. */
const GUARD_RULES = [
  ["Three workflow ids", "<code>hello</code>, <code>pipeline</code>, <code>approval-demo</code>. A workflow id from the request is never forwarded."],
  ["Server-chosen input", "The guard picks each run's input, so a visitor cannot steer what executes in the guest."],
  ["Five RPC methods", "Named as literals in <code>guard.ts</code>. No method name from a request reaches the gateway."],
  ["2 concurrent, queue of 8", "Six starts per IP per ten minutes, counted on the Cloudflare edge IP."],
  ["256-bit approval token", "Minted at start, compared with <code>timingSafeEqual</code>. Nothing else resolves a gate."],
  ["Five minute hard cap", "The guard cancels the run and frees its slot. Responses are built field by field."],
];

/** The two recorded hosts. Every value is taken from the capture below it. */
const HOSTS = [
  {
    hypervisor: "QEMU/KVM",
    title: "GCE n2-standard-2, nested virtualization",
    tiles: [
      ["Mixtape", "coder-dev x86_64, built from source"],
      ["Guest", "stereOS dev-f269d96, Linux 6.18.33 x86_64"],
      ["Run id", "55c1ccb5-9ddf-4912-82eb-eb35efd69767"],
      ["Sandbox", "1,877 ms"],
    ],
    proof: "primeCount 2508 below 22423, computed by Bun 1.2.21 x64 in the guest",
  },
  {
    hypervisor: "Apple Virtualization.framework via mb",
    title: "Apple Silicon Mac",
    tiles: [
      ["Mixtape", "coder-arm64:latest, fetched by hand"],
      ["Guest", "stereOS 2026.03.04.0, Linux 6.12.74 aarch64"],
      ["Run id", "c69a9b7f-762d-478e-9716-114e22f6c308"],
      ["Sandbox", "768 ms"],
    ],
    proof: "primeCount 2448 below 21831, computed by Bun 1.2.21 arm64 in the guest",
  },
];

/** One numbered step per diagram stage, each carrying its own capture excerpt. */
const WALKTHROUGH = [
  ["stereOS VM", "The host boots the mixtape under QEMU/KVM and waits for the guest to answer on SSH.", "== guest ==", 5],
  ["Smithers", "Smithers starts the run on the host. The workflow holds one node.", "info  starting workflow run", 3],
  ["SSH · provider seam", "The provider bundles the child workflow, uploads it over SSH, and runs the guest launcher.", "SandboxCreated", 2],
  ["Bun in guest", "The guest's Bun executes the bundle and writes the result the engine collects.", "SandboxBundleReceived", 2],
  ["result JSON", "The output is the guest's own report: its OS, kernel, and hostname, none of which exist on the host.", '"os": "stereOS dev-f269d96"', 4],
  ["audit", "The prompt hash reproduces on the host. It shows input and output agree; it is not provenance.", "sha256sum", 2],
];

// ── the Implementation tab's source set ─────────────────────────────────────

/** Directories walked into the file tree, and the extensions worth showing. */
const TREE_DIRS = ["real", "demo", "page", "e2e", "project"];
const TREE_FILES = ["build.mjs", "README.md", "wrangler.jsonc"];
const TREE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".sh", ".toml", ".json", ".jsonc", ".md", ".html", ".css",
]);
const LANGUAGES = {
  ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "js", ".sh": "bash",
  ".toml": "toml", ".json": "json", ".jsonc": "jsonc", ".md": "markdown", ".html": "html",
  ".css": "css", ".service": "ini",
};

/** Every implementation file, in tree order. Captures and build output stay out. */
async function collectSources() {
  const found = [];
  const walk = async (dir) => {
    for (const entry of (await readdir(join(here, dir), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = `${dir}/${entry.name}`;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const extension = extname(entry.name);
      if (!TREE_EXTENSIONS.has(extension) && !entry.name.endsWith(".service")) continue;
      found.push(path);
    }
  };
  for (const dir of TREE_DIRS) await walk(dir);
  for (const file of TREE_FILES) found.push(file);
  return found;
}

/** Resolve the Shiki that pnpm hoisted into the store, without a manifest here. */
async function loadShiki() {
  const store = join(repoRoot, "node_modules", ".pnpm");
  const candidates = (await readdir(store)).filter((name) => /^shiki@/.test(name)).sort();
  if (candidates.length === 0) throw new Error("shiki is not installed; run pnpm install at the repo root");
  return import(join(store, candidates.at(-1), "node_modules", "shiki", "dist", "index.mjs"));
}

/**
 * Tokenize every source once, for both themes at once, and store the text apart
 * from the colors. A token's text is identical in both themes, so the payload
 * carries one copy of the code plus two small index arrays into a color table.
 */
async function tokenizeSources(paths) {
  const { codeToTokens } = await loadShiki();
  const palettes = { light: [], dark: [] };
  const index = { light: new Map(), dark: new Map() };
  const intern = (theme, color) => {
    const table = index[theme];
    let at = table.get(color);
    if (at === undefined) {
      at = palettes[theme].push(color) - 1;
      table.set(color, at);
    }
    return at;
  };
  const files = {};
  for (const path of paths) {
    const code = await read(path);
    const language = LANGUAGES[extname(path)] ?? (path.endsWith(".service") ? "ini" : "text");
    const { tokens } = await codeToTokens(code, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
    });
    files[path] = {
      lang: language,
      bytes: Buffer.byteLength(code),
      text: tokens.map((line) => line.map((token) => token.content)),
      light: tokens.map((line) => line.map((token) => intern("light", token.htmlStyle?.color ?? ""))),
      dark: tokens.map((line) => line.map((token) => intern("dark", token.htmlStyle?.["--shiki-dark"] ?? ""))),
    };
  }
  return { palettes, files };
}

/** Bundle page/impl into one self-hosted ES module with its sources inlined. */
async function buildImplBundle(sources) {
  const esbuild = require(join(repoRoot, "node_modules", "esbuild"));
  const dataFile = join(await mkdtempDir(), "sources.js");
  await writeFile(dataFile, `export const sources = ${JSON.stringify(sources)};\n`);
  const result = await esbuild.build({
    entryPoints: [join(here, "page", "impl", "main.jsx")],
    outfile: join(siteDir, "impl.js"),
    bundle: true,
    format: "esm",
    minify: true,
    jsx: "automatic",
    target: "es2022",
    absWorkingDir: repoRoot,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "impl-sources",
        setup(build) {
          build.onResolve({ filter: /^#sources$/ }, () => ({ path: dataFile }));
        },
      },
    ],
    logLevel: "warning",
  });
  if (result.errors.length > 0) throw new Error("impl bundle failed");
}

async function mkdtempDir() {
  const dir = join(tmpdir(), `stereos-impl-${process.pid}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ── build ───────────────────────────────────────────────────────────────────

await mkdir(siteDir, { recursive: true });

const captures = {
  "GCE nested virt / KVM / x86_64 mixtape": await read("real", "transcript-linux.txt"),
  "macOS / Apple hypervisor / aarch64 mixtape": await read("real", "transcript.txt"),
};
const linux = captures["GCE nested virt / KVM / x86_64 mixtape"];

const evidenceCards = HOSTS.map(
  (host) =>
    `<div class="card"><div class="cap"><span>${escape(host.hypervisor)}</span><span class="pill ok">finished</span></div>` +
    `<div class="body"><h3>${escape(host.title)}</h3><dl class="tiles" style="margin-top:10px">` +
    host.tiles
      .map(([term, value]) => `<div class="tile"><dt>${escape(term)}</dt><dd>${escape(value)}</dd></div>`)
      .join("") +
    `</dl><p class="note" style="margin-top:10px">${escape(host.proof)}</p></div></div>`,
).join("\n");

const walkthrough =
  `<ol class="walk">` +
  WALKTHROUGH.map(
    ([stage, sentence, anchor, count]) =>
      `<li><span class="stage">${escape(stage)}</span><p>${sentence}</p>` +
      `<pre class="excerpt">${escape(excerpt(linux, anchor, count))}</pre></li>`,
  ).join("\n") +
  `</ol>`;

const guardRules =
  `<div class="row" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))">` +
  GUARD_RULES.map(([title, note]) => `<div class="card"><div class="body"><h3>${escape(title)}</h3><p class="note">${note}</p></div></div>`).join("\n") +
  `</div>`;

const paths = await collectSources();
const sources = await tokenizeSources(paths);
await buildImplBundle(sources);

const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
const template = await read("page", "index.template.html");
await writeFile(
  join(siteDir, "index.html"),
  template
    .replace("__FLOW_DIAGRAM__", flowDiagram())
    .replace("__EVIDENCE_CARDS__", `<div class="row">${evidenceCards}</div>`)
    .replace("__WALKTHROUGH__", walkthrough)
    .replace("__GUARD_RULES__", guardRules)
    .replaceAll("__STAMP__", stamp),
);

await writeFile(
  join(siteDir, "real-run.js"),
  `// Generated by examples/stereos-sandbox-provider/build.mjs from real/. Do not edit.\nexport const captures = ${JSON.stringify(captures, null, 2)};\n`,
);
await writeFile(join(siteDir, "live.js"), await read("page", "live.js"));
await writeFile(join(siteDir, "evidence.js"), await read("page", "evidence.js"));
await writeFile(join(siteDir, "proposed-api.html"), await read("tab1-source", "stereos-sandbox-provider.html"));
await writeFile(
  join(siteDir, "_headers"),
  `/*\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Content-Type-Options: nosniff\n`,
);

const bundle = await stat(join(siteDir, "impl.js"));
console.log(`site/: ${paths.length} sources in the tree, impl.js ${(bundle.size / 1024).toFixed(0)} KiB`);

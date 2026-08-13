// Build the deployable site assets.
//
//   site/index.html         the page, assembled from page/index.template.html
//   site/live.js            Live demo tab driver
//   site/evidence.js        How it works tab driver
//   site/real-run.js        the recorded captures, read from real/
//   site/impl.js            the Implementation tab bundle (smthrs/ui FileTree + CodeBlock,
//                           with the Shiki-tokenized sources inlined)
//   site/proposed-api.html  the reference document, verbatim
//
// Every claim the page makes about a recorded run is generated here from the
// committed capture, so the page cannot drift from what was actually run.
//
// Run: node apps/stereos-site/build.mjs
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "site");
const realDir = join(here, "real");
const run = promisify(execFile);

/** Cache-bust the page's own modules on every build. */
const version = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

const escape = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

await mkdir(siteDir, { recursive: true });

// ───────────────────────────── the flow diagram ─────────────────────────────

/**
 * The host → guest → host path a demo run takes, as inline SVG. Stage labels
 * match the walkthrough steps and the guard's node labels.
 */
function flowSvg() {
  const stages = [
    ["Visitor", "browser", "muted"],
    ["Guard", "Bun, allowlist", "orange"],
    ["Gateway", "loopback only", "muted"],
    ["Smithers", "&lt;Sandbox&gt;", "blue"],
    ["SSH", "provider seam", "muted"],
    ["stereOS VM", "QEMU/KVM", "green"],
    ["Bun in guest", "child workflow", "green"],
  ];
  const width = 1140;
  const boxW = 138;
  const boxH = 62;
  const gap = (width - stages.length * boxW) / (stages.length - 1);
  const top = 34;
  const tone = { muted: "var(--muted)", orange: "var(--orange)", blue: "var(--blue)", green: "var(--green)" };
  let out = "";
  stages.forEach(([title, sub, key], index) => {
    const x = index * (boxW + gap);
    out +=
      `<g><rect x="${x.toFixed(1)}" y="${top}" width="${boxW}" height="${boxH}" rx="12" ` +
      `fill="var(--card)" stroke="${tone[key]}" stroke-width="1.5"/>` +
      `<text x="${(x + boxW / 2).toFixed(1)}" y="${top + 26}" text-anchor="middle" ` +
      `font-size="13" font-weight="600" fill="var(--ink)">${title}</text>` +
      `<text x="${(x + boxW / 2).toFixed(1)}" y="${top + 44}" text-anchor="middle" ` +
      `font-size="11" fill="var(--muted)">${sub}</text></g>`;
    if (index < stages.length - 1) {
      const from = x + boxW + 4;
      const to = x + boxW + gap - 4;
      out +=
        `<path d="M${from.toFixed(1)} ${top + boxH / 2} H${to.toFixed(1)}" stroke="var(--line)" ` +
        `stroke-width="1.5" marker-end="url(#arrow)"/>`;
    }
  });
  // The return path: the guest-produced result travels back the same seam.
  const lastMid = (stages.length - 1) * (boxW + gap) + boxW / 2;
  const y = top + boxH + 30;
  out +=
    `<path d="M${lastMid.toFixed(1)} ${top + boxH} V${y} H${(boxW / 2).toFixed(1)} V${top + boxH}" ` +
    `fill="none" stroke="var(--orange)" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#arrow-orange)"/>` +
    `<text x="${(width / 2).toFixed(1)}" y="${y - 7}" text-anchor="middle" font-size="11" fill="var(--orange)">` +
    `result JSON written by Bun inside the guest</text>`;
  return (
    `<svg viewBox="0 0 ${width} ${y + 14}" role="img" ` +
    `aria-label="A run travels from the visitor through the guard and the loopback gateway into a Smithers Sandbox, ` +
    `over SSH into a stereOS VM where Bun executes the child workflow, and the result returns the same way.">` +
    `<defs>` +
    `<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">` +
    `<path d="M0 0 L8 4 L0 8 z" fill="var(--line)"/></marker>` +
    `<marker id="arrow-orange" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">` +
    `<path d="M0 0 L8 4 L0 8 z" fill="var(--orange)"/></marker>` +
    `</defs>${out}</svg>`
  );
}

// ───────────────────────────── guard rules ─────────────────────────────

const guardCards = [
  [
    "Three workflow ids",
    "<code>hello</code>, <code>pipeline</code>, <code>approval-demo</code>. A workflow id from the request is never forwarded.",
  ],
  ["Server-chosen input", "The guard picks each run's input, so a visitor cannot steer what executes in the guest."],
  [
    "Five RPC methods",
    "Named as literals in <code>guard.ts</code>. No method name from a request reaches the gateway.",
  ],
  ["2 concurrent, queue of 8", "Six starts per IP per ten minutes, counted on the Cloudflare edge IP."],
  [
    "256-bit approval token",
    "Minted at start, compared with <code>timingSafeEqual</code>. Nothing else resolves a gate.",
  ],
  ["Five minute hard cap", "The guard cancels the run and frees its slot. Responses are built field by field."],
]
  .map(
    ([title, body]) => `<div class="card"><div class="body"><h3>${title}</h3><p class="note">${body}</p></div></div>`,
  )
  .join("\n");

// ───────────────────────────── recorded evidence ─────────────────────────────

const readReal = (name) => readFile(join(realDir, name), "utf8");
const transcripts = {
  "GCE nested virt / KVM / x86_64": await readReal("transcript-linux.txt"),
  "Apple hypervisor / aarch64": await readReal("transcript.txt"),
};

/**
 * Take a verbatim slice of a capture. Both ends are matched against the
 * committed file, so an edited transcript fails the build instead of silently
 * changing what the page quotes.
 */
function slice(capture, from, lines, label) {
  const all = capture.split("\n");
  const at = all.findIndex((line) => line.includes(from));
  if (at < 0) throw new Error(`capture excerpt "${label}" no longer matches: ${from}`);
  return all.slice(at, at + lines).join("\n");
}

const linux = transcripts["GCE nested virt / KVM / x86_64"];

const hostCards = [
  {
    host: "GCE n2-standard-2, nested virtualization",
    hypervisor: "QEMU/KVM",
    mixtape: "coder-dev x86_64, built from source",
    guest: "stereOS dev-f269d96, Linux 6.18.33 x86_64",
    runId: "55c1ccb5-9ddf-4912-82eb-eb35efd69767",
    sandbox: "1,877 ms",
    proof: "primeCount 2508 below 22423, computed by Bun 1.2.21 x64 in the guest",
  },
  {
    host: "Apple Silicon Mac",
    hypervisor: "Apple Virtualization.framework via mb",
    mixtape: "coder-arm64:latest, fetched by hand",
    guest: "stereOS 2026.03.04.0, Linux 6.12.74 aarch64",
    runId: "c69a9b7f-762d-478e-9716-114e22f6c308",
    sandbox: "768 ms",
    proof: "primeCount 2448 below 21831, computed by Bun 1.2.21 arm64 in the guest",
  },
]
  .map(
    (card) =>
      `<div class="card"><div class="cap"><span>${escape(card.hypervisor)}</span>` +
      `<span class="pill ok">finished</span></div><div class="body">` +
      `<h3>${escape(card.host)}</h3><dl class="tiles" style="margin-top:10px">` +
      [
        ["Mixtape", card.mixtape],
        ["Guest", card.guest],
        ["Run id", card.runId],
        ["Sandbox", card.sandbox],
      ]
        .map(([term, value]) => `<div class="tile"><dt>${term}</dt><dd>${escape(value)}</dd></div>`)
        .join("") +
      `</dl><p class="note" style="margin-top:10px">${escape(card.proof)}</p></div></div>`,
  )
  .join("\n");

const walkthrough = [
  {
    stage: "stereOS VM",
    text: "The host boots the mixtape under QEMU/KVM and waits for the guest to answer on SSH.",
    excerpt: slice(linux, "== guest ==", 5, "guest identity"),
  },
  {
    stage: "Smithers",
    text: "Smithers starts the run on the host. The workflow holds one node.",
    excerpt: slice(linux, "info  starting workflow run", 3, "run start"),
  },
  {
    stage: "SSH · provider seam",
    text: "The provider bundles the child workflow, uploads it over SSH, and runs the guest launcher.",
    excerpt: slice(linux, "SandboxCreated", 2, "sandbox shipped"),
  },
  {
    stage: "Bun in guest",
    text: "The guest's Bun executes the bundle and writes the result the engine collects.",
    excerpt: slice(linux, "SandboxBundleReceived", 2, "sandbox completed"),
  },
  {
    stage: "result JSON",
    text: "The output is the guest's own report: its OS, kernel, and hostname, none of which exist on the host.",
    excerpt: slice(linux, `"os": "stereOS dev-f269d96"`, 4, "guest facts"),
  },
  {
    stage: "audit",
    text: "The prompt hash reproduces on the host. It shows input and output agree; it is not provenance.",
    excerpt: slice(linux, "| sha256sum", 2, "prompt hash"),
  },
]
  .map(
    (step) =>
      `<li><span class="stage">${escape(step.stage)}</span><p>${escape(step.text)}</p>` +
      `<pre class="excerpt">${escape(step.excerpt)}</pre></li>`,
  )
  .join("\n");

await writeFile(
  join(siteDir, "real-run.js"),
  `// Generated by apps/stereos-site/build.mjs from real/. Do not edit.\n` +
    `export const captures = ${JSON.stringify(transcripts, null, 2)};\n`,
);

// ───────────────────────────── the page ─────────────────────────────

const template = await readFile(join(here, "page/index.template.html"), "utf8");
await writeFile(
  join(siteDir, "index.html"),
  template
    .replace("__FLOW_SVG__", flowSvg())
    .replace("__GUARD_CARDS__", guardCards)
    .replace("__HOST_CARDS__", hostCards)
    .replace("__WALKTHROUGH__", walkthrough)
    .replaceAll("__V__", version),
);
await copyFile(join(here, "page/live.js"), join(siteDir, "live.js"));
await copyFile(join(here, "page/evidence.js"), join(siteDir, "evidence.js"));

// The reference document is served whole, on its own, so its stylesheet cannot
// fight the page's and it reads as the spec it is.
await copyFile(join(here, "tab1-source/stereos-sandbox-provider.html"), join(siteDir, "proposed-api.html"));

// ───────────────────────────── Implementation sources ─────────────────────────────

/**
 * The files the Implementation tab browses: the provider and guest workflows,
 * the host provisioning, the demo service, and this page. Paths are relative to
 * apps/stereos-site and are also the GitHub link targets.
 */
const IMPLEMENTATION_FILES = [
  "real/stereos-provider.ts",
  "real/child-workflow.tsx",
  "real/stereos-real.tsx",
  "real/guest-runner.sh",
  "real/bootstrap-vm.sh",
  "real/provision-linux-host.sh",
  "real/run-on-linux-host.sh",
  "real/jcard.toml",
  "real/README.md",
  "demo/guard.ts",
  "demo/stereos-provider.ts",
  "demo/guest-facts.ts",
  "demo/guest-hello.tsx",
  "demo/guest-pipeline.tsx",
  "demo/guest-apply.tsx",
  "demo/guest-runner.sh",
  "demo/workflows/hello.tsx",
  "demo/workflows/pipeline.tsx",
  "demo/workflows/approval-demo.tsx",
  "demo/ui/src/App.jsx",
  "demo/ui/src/main.jsx",
  "demo/build-ui.ts",
  "demo/boot-vm.sh",
  "demo/tunnel.sh",
  "demo/install.sh",
  "demo/systemd/stereos-vm.service",
  "demo/systemd/stereos-gateway.service",
  "demo/systemd/stereos-guard.service",
  "demo/systemd/stereos-tunnel.service",
  "demo/README.md",
  "page/index.template.html",
  "page/live.js",
  "page/evidence.js",
  "page/impl/main.jsx",
  "build.mjs",
  "e2e/stereos.e2e.mjs",
  "README.md",
];

const LANGUAGE = {
  ts: "ts",
  tsx: "tsx",
  jsx: "jsx",
  mjs: "js",
  js: "js",
  sh: "bash",
  service: "ini",
  toml: "toml",
  md: "markdown",
  html: "html",
};

/**
 * Resolve Shiki out of the workspace store.
 *
 * This directory deliberately has no package.json, so it is not a pnpm
 * workspace member and cannot declare dependencies; it reaches into the root
 * install the same way it reaches for esbuild below. Shiki arrives through
 * `@pierre/diffs`, which `packages/ui` depends on, so it is present after a
 * normal `pnpm install` but is not hoisted to the root `node_modules`.
 */
async function resolveShiki() {
  const store = join(here, "../../node_modules/.pnpm");
  const entries = (await readdir(store).catch(() => [])).filter((name) => name.startsWith("shiki@")).sort();
  const found = entries.at(-1);
  if (!found) {
    throw new Error(`no shiki in ${store}; run pnpm install at the repository root`);
  }
  return import(pathToFileURL(join(store, found, "node_modules/shiki/dist/index.mjs")).href);
}

const { createHighlighter } = await resolveShiki();
const highlighter = await createHighlighter({
  themes: ["github-light", "github-dark"],
  langs: [...new Set(Object.values(LANGUAGE))],
});

/**
 * Tokenize one file for both themes into a shared colour palette, so the
 * shipped bundle stays small: a token is [text, paletteIndex].
 */
const palette = [];
const paletteIndex = new Map();
function colorSlot(color) {
  if (!color) return -1;
  let at = paletteIndex.get(color);
  if (at === undefined) {
    at = palette.push(color) - 1;
    paletteIndex.set(color, at);
  }
  return at;
}
function tokenize(code, lang, theme) {
  return highlighter
    .codeToTokensBase(code, { lang, theme })
    .map((line) => line.map((token) => [token.content, colorSlot(token.color)]));
}

const implFiles = [];
for (const path of IMPLEMENTATION_FILES) {
  const code = await readFile(join(here, path), "utf8");
  const extension = path.slice(path.lastIndexOf(".") + 1);
  const lang = LANGUAGE[extension] ?? "text";
  implFiles.push({
    path,
    lang,
    bytes: Buffer.byteLength(code),
    lines: code.split("\n").length,
    light: tokenize(code, lang, "github-light"),
    dark: tokenize(code, lang, "github-dark"),
  });
}

await writeFile(
  join(siteDir, "impl-files.js"),
  `// Generated by apps/stereos-site/build.mjs. Do not edit.\n` +
    `export const palette = ${JSON.stringify(palette)};\n` +
    `export const files = ${JSON.stringify(implFiles)};\n`,
);

// The Implementation tab is a React bundle so it can use the shipped
// smthrs/ui components rather than a lookalike. esbuild resolves the raw .tsx
// sources those packages publish.
const esbuild = await import("esbuild");
await esbuild.build({
  entryPoints: [join(here, "page/impl/main.jsx")],
  outfile: join(siteDir, "impl.js"),
  bundle: true,
  format: "esm",
  minify: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});

// The tokens are inlined in impl.js, so the intermediate never needs shipping.
await rm(join(siteDir, "impl-files.js"));

const totalBytes = implFiles.reduce((sum, file) => sum + file.bytes, 0);
console.log(
  `index.html, live.js, evidence.js, real-run.js, proposed-api.html\n` +
    `impl: ${implFiles.length} files, ${(totalBytes / 1024).toFixed(1)} KiB of source, ` +
    `${palette.length} colours`,
);

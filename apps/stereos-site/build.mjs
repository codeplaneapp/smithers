// Build the deployable site assets.
//
// 1. Assembles site/index.html from page/index.template.html, scoping the tab-4
//    reference document's stylesheet to #panel-api and lifting its <main>
//    verbatim.
// 2. Copies the page scripts to site/.
// 3. Serializes the real/ evidence (recorded transcripts plus provider sources)
//    into site/real-run.js.
// 4. Serializes the implementation sources into site/impl-files.js and bundles
//    the Implementation file tree, a React app built on the shipped
//    smthrs/ui components, into site/impl.js.
//
// Run: node apps/stereos-site/build.mjs
import { copyFile, readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const siteDir = join(here, "site");
const require = createRequire(import.meta.url);

await mkdir(siteDir, { recursive: true });

// ── 1. The reference document ────────────────────────────────────────────────
//
// The reference ships a complete page stylesheet (`body`, `h1`, `table`, ...).
// The rest of this page has its own design system, so every reference rule is
// rewritten to apply only inside #panel-api. `:root` and `body` rules become
// `#panel-api` rules so the document keeps its own tokens and type without
// reaching the shell.
const SCOPE = "#panel-api";

/** Prefix one comma-separated selector list with the panel scope. */
function scopeSelector(selectorList) {
  return selectorList
    .split(",")
    .map((selector) => {
      const trimmed = selector.trim();
      if (!trimmed) return trimmed;
      // Tokens that describe the document itself become the panel.
      if (trimmed === ":root" || trimmed === "html" || trimmed === "body") return SCOPE;
      if (trimmed === "*") return `${SCOPE}, ${SCOPE} *`;
      return `${SCOPE} ${trimmed}`;
    })
    .filter(Boolean)
    .join(", ");
}

/**
 * Rewrite a stylesheet so every rule is scoped to {@link SCOPE}.
 * Handles nested at-rules (`@media`) by scoping their inner rules instead.
 */
function scopeCss(css) {
  let out = "";
  let index = 0;
  while (index < css.length) {
    const brace = css.indexOf("{", index);
    if (brace === -1) {
      out += css.slice(index);
      break;
    }
    const prelude = css.slice(index, brace).trim();
    // Find the matching close brace for this block.
    let depth = 0;
    let end = brace;
    for (; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = css.slice(brace + 1, end);
    if (prelude.startsWith("@")) {
      // Conditional group rules wrap more rules; scope those.
      out += `${prelude} {${/^@(media|supports|layer|container)/.test(prelude) ? scopeCss(body) : body}}\n`;
    } else {
      out += `${scopeSelector(prelude)} {${body}}\n`;
    }
    index = end + 1;
  }
  return out;
}

const reference = await readFile(join(here, "tab1-source/stereos-sandbox-provider.html"), "utf8");
const styleMatch = reference.match(/<style>([\s\S]*?)<\/style>/);
const mainMatch = reference.match(/<main>[\s\S]*?<\/main>/);
if (!styleMatch || !mainMatch) {
  throw new Error("reference document is missing its <style> or <main>");
}

const flowDiagram = (await readFile(join(here, "page/flow-diagram.svg"), "utf8")).trim();

for (const script of ["live.js", "evidence.js"]) {
  await copyFile(join(here, "page", script), join(siteDir, script));
}

// The removed WebContainer tab needed cross-origin isolation for
// SharedArrayBuffer, which COEP: require-corp provided. Nothing on the page
// needs it now, and require-corp would block the cross-origin demo iframe, so
// only the framing and sniffing protections remain.
await writeFile(
  join(siteDir, "_headers"),
  `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: SAMEORIGIN\n`,
);

// ── 2. Recorded evidence ─────────────────────────────────────────────────────
const realDir = join(here, "real");
const realFile = (name) => readFile(join(realDir, name), "utf8");
const realRun = {
  hosts: [
    {
      key: "linux",
      label: "GCE nested virt · KVM · x86_64 mixtape",
      transcript: await realFile("transcript-linux.txt"),
      kpis: {
        Host: "GCE n2-standard-2, nested virt",
        Hypervisor: "QEMU/KVM",
        Mixtape: "coder-dev x86_64, built from source",
        "Guest kernel": "Linux 6.18.33 x86_64",
        "Run id": "55c1ccb5-9ddf-4912-82eb-eb35efd69767",
        "Sandbox duration": "1,939 ms",
        "Guest reported": "agent@coder-dev, Bun 1.2.21 x64",
      },
    },
    {
      key: "macos",
      label: "Apple hypervisor · aarch64 mixtape",
      transcript: await realFile("transcript.txt"),
      kpis: {
        Host: "Apple Silicon Mac",
        Hypervisor: "Apple Virtualization.framework via mb",
        Mixtape: "coder-arm64:latest, fetched by hand",
        "Guest kernel": "Linux 6.12.74 aarch64",
        "Sandbox duration": "768 ms",
        "Guest reported": "agent@coder, Bun 1.2.21 arm64",
      },
    },
  ],
};
await writeFile(
  join(siteDir, "real-run.js"),
  `// Generated by apps/stereos-site/build.mjs from real/. Do not edit.\nexport const realRun = ${JSON.stringify(realRun, null, 2)};\n`,
);

// ── 3. Implementation sources ────────────────────────────────────────────────
//
// Every file the Implementation tab lists is read from the repository here, so
// the tab cannot drift from the code that actually runs.
const IMPL_ROOTS = [
  { dir: "apps/stereos-site/service", label: "service" },
  { dir: "apps/stereos-site/real", label: "real" },
  { dir: "apps/stereos-site/page", label: "page" },
];
const IMPL_SINGLES = ["apps/stereos-site/build.mjs", "apps/stereos-site/README.md", "apps/stereos-site/e2e/stereos.e2e.mjs"];
const SKIP = new Set(["node_modules", "dist", ".smithers"]);
const TEXT = /\.(ts|tsx|js|jsx|mjs|sh|md|toml|json|html|css|svg|service)$/;

/** Collect every text source under a directory, relative to the repository root. */
async function collect(dir, out = []) {
  for (const entry of await readdir(join(repoRoot, dir), { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await collect(rel, out);
    else if (TEXT.test(entry.name)) out.push(rel);
  }
  return out;
}

const implPaths = [];
for (const root of IMPL_ROOTS) implPaths.push(...(await collect(root.dir)));
implPaths.push(...IMPL_SINGLES);

const implFiles = {};
for (const path of implPaths.sort()) {
  // Transcripts are evidence, not implementation, and are already on the
  // How it works tab. The generated bundle input is this listing itself.
  if (path.includes("transcript") || path.endsWith(".generated.js")) continue;
  implFiles[path] = await readFile(join(repoRoot, path), "utf8");
}
// Written beside the bundle entry rather than into site/: it is the bundler's
// input, not a deployed asset, and shipping it would double the payload.
await writeFile(
  join(here, "page/impl/impl-files.generated.js"),
  `// Generated by apps/stereos-site/build.mjs from the repository. Do not edit.\nexport const implFiles = ${JSON.stringify(implFiles, null, 2)};\n`,
);

// ── 4. The Implementation file tree bundle ───────────────────────────────────
//
// A small React app composed from shipped smthrs/ui components. esbuild is
// already a dependency of this repository and produces a self-hosted bundle;
// nothing is fetched from a CDN.
const esbuild = require("esbuild");
await esbuild.build({
  entryPoints: [join(here, "page/impl/main.jsx")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  outfile: join(siteDir, "impl.js"),
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "text" },
  logLevel: "warning",
});

// site/ used to hold the WebContainer bundle and its project tree. Both belong
// to the removed simulation tab.
for (const stale of ["webcontainer-api.js", "project-files.js", "demo.js", "real.js"]) {
  await rm(join(siteDir, stale), { force: true });
}

// The cache key is a digest of everything index.html loads, so any rebuild that
// changes a script also changes its URL. A date stamp would not: two builds on
// the same day would share a URL and the CDN would keep serving the first.
const assets = await Promise.all(
  ["live.js", "evidence.js", "impl.js", "real-run.js"].map((name) => readFile(join(siteDir, name), "utf8")),
);
const stamp = createHash("sha256").update(assets.join("\u0000")).digest("hex").slice(0, 12);

const template = await readFile(join(here, "page/index.template.html"), "utf8");
await writeFile(
  join(siteDir, "index.html"),
  template
    .replace("__REFERENCE_STYLE__", scopeCss(styleMatch[1].trim()).trim())
    .replace("__REFERENCE_MAIN__", mainMatch[0])
    .replaceAll("__FLOW_DIAGRAM__", flowDiagram)
    .replaceAll("__BUILD__", stamp),
);

console.log(
  `index.html (v=${stamp}) + live.js + evidence.js + impl.js; impl-files.js: ${Object.keys(implFiles).length} files; real-run.js: ${realRun.hosts.length} hosts`,
);

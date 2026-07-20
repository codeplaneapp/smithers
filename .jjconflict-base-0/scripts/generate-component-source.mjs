#!/usr/bin/env node
/**
 * Inject the implementation source of each *composite* component into its docs
 * page as a tabbed `<CodeGroup>` so readers can see how the component is built
 * from primitives without leaving the page.
 *
 * For every page listed under the "Composite" group in docs/docs.json this
 * writes a `## Source` section containing, as one tab per file:
 *   - the component's own source (e.g. ScanFixVerify.js)
 *   - every repo file it imports: local `./*.js` siblings and resolved
 *     `@smithers-orchestrator/*` files (one level deep, `react` excluded)
 *   - the prop/type files it references via JSDoc `import("./*.ts")` typedefs
 *
 * The section is delimited by GENERATED:COMPONENT-SOURCE markers and is fully
 * regenerated each run, so it is the source of truth, never hand-edited. The
 * doc gates (scripts/check-docs.mjs) and the LLM bundle generator
 * (scripts/generate-llms.ts) skip this region, so verbatim source (em-dashes,
 * cross-package imports) does not trip house-style checks or bloat llms-*.txt.
 *
 *   node scripts/generate-component-source.mjs          rewrite pages in place
 *   node scripts/generate-component-source.mjs --check   exit 1 if any page is stale
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_COMPONENTS = join(root, "docs", "components");
const DOCS_JSON = join(root, "docs", "docs.json");

const START = "{/* GENERATED:COMPONENT-SOURCE START (regenerate: pnpm docs:components) */}";
const END = "{/* GENERATED:COMPONENT-SOURCE END */}";
const REGION_RE = /\n*\{\/\* GENERATED:COMPONENT-SOURCE START[\s\S]*?GENERATED:COMPONENT-SOURCE END \*\/\}\n*/;

const check = process.argv.includes("--check");

/** Find the page slugs under the docs.json "Composite" navigation group. */
function compositeSlugs() {
  const json = JSON.parse(readFileSync(DOCS_JSON, "utf8"));
  let pages = null;
  const visit = (node) => {
    if (pages || node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.group === "Composite" && Array.isArray(node.pages)) {
      pages = node.pages;
      return;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(json);
  if (!pages) throw new Error('Could not find the "Composite" group in docs/docs.json');
  return pages
    .filter((page) => typeof page === "string")
    .map((page) => page.replace(/^components\//, ""));
}

/** Read the component name from a page's frontmatter `title: <Name>`. */
function componentName(mdx) {
  const match = mdx.match(/^title:\s*<?([A-Za-z0-9_]+)>?/m);
  if (!match) throw new Error("Could not read component name from frontmatter title");
  return match[1];
}

function resolveImport(spec, fromFile) {
  if (spec.startsWith(".")) return resolve(dirname(fromFile), spec);
  return require.resolve(spec);
}

/**
 * Collect the repo files a component depends on, in a deterministic order:
 * real `import ... from` specifiers first (source order), then JSDoc
 * `import("./x.ts")` type references. `react` and other bare externals are
 * skipped; only local and `@smithers-orchestrator/*` files are included.
 */
function collectDeps(srcPath) {
  const src = readFileSync(srcPath, "utf8");
  const files = [];
  const seen = new Set([resolve(srcPath)]);
  const add = (path) => {
    const resolved = resolve(path);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      files.push(resolved);
    }
  };
  for (const match of src.matchAll(/import\s+[^;]*?\bfrom\s*["']([^"']+)["']/g)) {
    const spec = match[1];
    if (spec === "react") continue;
    if (!spec.startsWith(".") && !spec.startsWith("@smithers-orchestrator/")) continue;
    add(resolveImport(spec, srcPath));
  }
  for (const match of src.matchAll(/import\(["'](\.\/[^"']+\.tsx?)["']\)/g)) {
    add(resolveImport(match[1], srcPath));
  }
  return files;
}

function fenceLang(file) {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".ts")) return "ts";
  if (file.endsWith(".jsx")) return "jsx";
  return "js";
}

function codeBlock(file) {
  const code = readFileSync(file, "utf8").replace(/\s+$/, "");
  if (code.includes("```")) {
    throw new Error(`Refusing to embed ${file}: it contains a \`\`\` fence`);
  }
  return "```" + fenceLang(file) + " " + basename(file) + "\n" + code + "\n```";
}

function buildRegion(name, srcPath, deps) {
  const blocks = [srcPath, ...deps].map(codeBlock).join("\n\n");
  return (
    START +
    "\n## Source\n\n" +
    `The \`<${name}>\` implementation and the files it imports, straight from the ` +
    "package source. This section is generated; edit the source, not this block.\n\n" +
    "<CodeGroup>\n" +
    blocks +
    "\n</CodeGroup>\n" +
    END
  );
}

const stale = [];
for (const slug of compositeSlugs()) {
  const mdxPath = join(DOCS_COMPONENTS, `${slug}.mdx`);
  const mdx = readFileSync(mdxPath, "utf8");
  const name = componentName(mdx);
  const srcPath = join(root, "packages", "components", "src", "components", `${name}.js`);
  const region = buildRegion(name, srcPath, collectDeps(srcPath));
  const next = mdx.replace(REGION_RE, "\n").replace(/\s*$/, "") + "\n\n" + region + "\n";
  if (next === mdx) continue;
  if (check) {
    stale.push(slug);
  } else {
    writeFileSync(mdxPath, next);
    console.log(`✓ ${slug}.mdx`);
  }
}

if (check) {
  if (stale.length) {
    console.error(
      `\n✗ ${stale.length} composite doc(s) have stale embedded source:\n` +
        stale.map((slug) => `    components/${slug}.mdx`).join("\n") +
        "\n  Run: pnpm docs:components",
    );
    process.exit(1);
  }
  console.log("✓ composite component source embeds are up to date");
} else {
  console.log(`\nRegenerated source embeds for ${compositeSlugs().length} composite component(s).`);
}

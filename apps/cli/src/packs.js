import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, cpSync, mkdtempSync, writeFileSync, statSync, lstatSync, realpathSync, renameSync } from "node:fs";
import { accountsRoot } from "@smithers-orchestrator/accounts";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { decode, encode } from "@toon-format/toon";
import { loadManifest, parseManifest, renderManifest } from "./manifest.js";
import { evaluateEligibility, parseWorkflowFrontmatter } from "./workflows.js";

const ALLOWED = new Set(["smithers-orchestrator", "react", "zod"]);

export function parsePackSpec(spec) {
  if (typeof spec !== "string" || !spec.trim()) throw new Error("Pack spec is required");
  const raw = spec.trim();
  if (raw.startsWith("github:")) {
    const match = raw.slice(7).match(/^([^/]+)\/([^/#]+)(?:\/([^#]+))?(?:#(.+))?$/);
    if (!match) throw new Error(`Invalid GitHub pack spec: ${raw}`);
    return { kind: "github", owner: match[1], repo: match[2], subdir: match[3] ?? "", ref: match[4] ?? "HEAD", name: `${match[1]}-${match[2]}` };
  }
  {
    // Bare GitHub shorthand, npm-style: user/repo with an optional #ref.
    const bare = raw.match(/^([^/@#]+)\/([^/#]+?)(?:#(.+))?$/);
    if (bare) {
      return { kind: "github", owner: bare[1], repo: bare[2], subdir: "", ref: bare[3] ?? "HEAD", name: `${bare[1]}-${bare[2]}` };
    }
  }
  const npm = raw.startsWith("npm:") ? raw.slice(4) : raw;
  if (!raw.startsWith("file:") && (raw.startsWith("npm:") || /^[^/@][^/]*(?:@[^/]+)?$/.test(npm) || /^@[^/]+\/[^@]+(?:@[^/]+)?$/.test(npm))) {
    const at = npm.lastIndexOf("@");
    const name = at > 0 ? npm.slice(0, at) : npm;
    return { kind: "npm", package: name, version: at > 0 ? npm.slice(at + 1) : "latest", name: name.replace(/^@/, "").replaceAll("/", "-") };
  }
  if (raw.startsWith("file:")) return { kind: "file", path: resolve(raw.slice(5)), name: basename(raw.slice(5)) };
  throw new Error(`Unsupported pack spec: ${raw}`);
}

function packRoot(from, global, env = process.env) {
  if (global) return join(accountsRoot(env), "packs");
  let dir = resolve(from);
  while (true) {
    const candidate = join(dir, ".smithers");
    if (existsSync(candidate)) return join(candidate, "packs");
    const parent = dirname(dir);
    if (parent === dir) return join(resolve(from), ".smithers", "packs");
    dir = parent;
  }
}

export function packDirs(from = process.cwd(), global = false, env = process.env) { return packRoot(from, global, env); }
// The lock lives BESIDE the packs dir (.smithers/packs.lock.toon), not inside
// it — the packs dir holds only installed pack contents.
export function lockPath(root) { return join(dirname(root), "packs.lock.toon"); }
function readLock(root) {
  // Legacy location (inside the packs dir) is read as a fallback so packs
  // installed before the move keep updating; the next write lands beside.
  const path = existsSync(lockPath(root)) ? lockPath(root) : join(root, "packs.lock.toon");
  if (!existsSync(path)) return {};
  const value = decode(readFileSync(path, "utf8"));
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function writeLock(root, value) { mkdirSync(dirname(lockPath(root)), { recursive: true }); rmSync(join(root, "packs.lock.toon"), { force: true }); writeFileSync(lockPath(root), `${encode(value)}\n`); }

function assertNoInstalledSymlinks(root) {
  try { if (lstatSync(root).isSymbolicLink()) throw new Error(`Installed pack contains an unsupported symlink: ${root}`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; return; }
  const visit = (current) => {
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Installed pack contains an unsupported symlink: ${current}`);
    if (!info.isDirectory()) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) visit(join(current, entry.name));
  };
  visit(root);
}

function overlayTree(source, target) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const incoming = join(source, entry.name);
    const destination = join(target, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(destination) && !lstatSync(destination).isDirectory()) rmSync(destination, { force: true });
      mkdirSync(destination, { recursive: true });
      overlayTree(incoming, destination);
    } else {
      if (existsSync(destination) || lstatSyncSafe(destination)) rmSync(destination, { recursive: true, force: true });
      cpSync(incoming, destination, { recursive: true });
    }
  }
}

function lstatSyncSafe(path) { try { lstatSync(path); return true; } catch { return false; } }

/** Lock entries for both scopes, for `packs update` (the lock — not the set of
 * currently-intact pack dirs — is the source of truth for what to update). */
export function listLockedPacks(from = process.cwd()) {
  return [false, true].flatMap((global) => {
    const root = packRoot(from, global);
    return Object.entries(readLock(root)).map(([name, entry]) => ({ name, entry, scope: global ? "global" : "local" }));
  });
}

function importAllowed(name) {
  // smithers-orchestrator subpaths matter: every canonical pack UI imports
  // "smithers-orchestrator/gateway-react" (and JSX emits ".../jsx-runtime").
  return name.startsWith(".") || ALLOWED.has(name)
    || name.startsWith("smithers-orchestrator/")
    || name.startsWith("@smithers-orchestrator/")
    || name.startsWith("react/")
    || name.startsWith("zod/");
}

/** Lex one module's import specifiers. Prefers Bun's transpiler (a real lexer:
 * ignores comments and string contents, sees static/dynamic imports,
 * export-from, require, and `import x = require(...)`); falls back to a
 * comment-stripped regex scan when Bun is unavailable. */
function moduleImports(file, source) {
  if (/\.(?:md|mdx)$/.test(file)) {
    return [...source.matchAll(/^\s*(?:import|export)\s+(?:[^"'\n]+?\s+from\s+)?["']([^"']+)["']/gm)].map((match) => match[1]);
  }
  if (/\.(?:css|scss|sass|less)$/.test(file)) {
    return [
      ...[...source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)].map((match) => match[1]),
      ...[...source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((match) => match[1]),
    ];
  }
  if (typeof Bun !== "undefined" && Bun.Transpiler) {
    try {
      return new Bun.Transpiler({ loader: "tsx" }).scanImports(source).map((record) => record.path);
    } catch (error) {
      throw new Error(`Pack file does not parse: ${file}: ${error?.message ?? error}`);
    }
  }
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const names = [];
  for (const match of stripped.matchAll(/\b(?:import|export)\s+(?:[^"'`;]+?\s+from\s+)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+\w+\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    names.push(match[1] ?? match[2] ?? match[3]);
  }
  return names;
}

function assertNoSymlinks(root) {
  if (lstatSync(root).isSymbolicLink()) throw new Error(`Pack contains an unsupported symlink: ${root}`);
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (lstatSync(file).isSymbolicLink()) {
        throw new Error(`Pack contains an unsupported symlink: ${file}`);
      }
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(root);
}

export function scanPackImports(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(entry.name)) files.push(file);
    }
  };
  visit(root);
  for (const file of files) {
    for (const name of moduleImports(file, readFileSync(file, "utf8"))) {
      if (!importAllowed(name)) {
        throw new Error(`Pack import not allowed: ${file} imports ${name}`);
      }
    }
  }
}

function validateArchiveManifest(archive, fallbackName, subdir = "") {
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n").filter(Boolean);
  const suffix = subdir ? `${subdir.replace(/\/+$/, "")}/smithers.toon` : "smithers.toon";
  const manifestEntry = entries.find((entry) => entry === suffix || entry.endsWith(`/${suffix}`));
  if (!manifestEntry) throw new Error("Invalid smithers pack: archive does not contain smithers.toon");
  const source = execFileSync("tar", ["-xOf", archive, manifestEntry], { encoding: "utf8" });
  try {
    return parseManifest(source);
  } catch (error) {
    if (!String(error?.message ?? error).includes("missing required name")) throw error;
    return parseManifest(`name: ${fallbackName}\n${source}`);
  }
}

function copyOrExtract(source, target, fallbackName, subdir = "") {
  if (existsSync(join(source, "smithers.toon"))) { cpSync(source, target, { recursive: true }); return; }
  validateArchiveManifest(source, fallbackName, subdir);
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", source, "-C", target]);
  // GitHub codeload tarballs wrap everything in a single `<repo>-<ref>/` root
  // dir. Flatten it whenever the manifest lives below that wrapper — directly
  // (`<root>/smithers.toon`) or under the requested subdir
  // (`<root>/<subdir>/smithers.toon`) — so callers can address `<target>/<subdir>`.
  const child = readdirSync(target, { withFileTypes: true }).find((entry) => entry.isDirectory());
  const manifestUnderChild = child && (existsSync(join(target, child.name, "smithers.toon"))
    || (subdir && existsSync(join(target, child.name, subdir, "smithers.toon"))));
  if (manifestUnderChild && !existsSync(join(target, "smithers.toon"))) {
    const staging = `${target}.flat`; rmSync(staging, { recursive: true, force: true }); cpSync(join(target, child.name), staging, { recursive: true }); rmSync(target, { recursive: true, force: true }); cpSync(staging, target, { recursive: true }); rmSync(staging, { recursive: true, force: true });
  }
}

/** Resolve a GitHub ref to the commit SHA it points at (lock contract records
 * commits, not movable refs). Falls back to the ref itself when the API is
 * unreachable — the integrity hash still pins the exact content. */
async function resolveGithubSha(owner, repo, ref) {
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
      headers: { Accept: "application/vnd.github.sha", "User-Agent": "smithers-cli" },
    });
    if (!response.ok) return ref;
    const sha = (await response.text()).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : ref;
  } catch { return ref; }
}

async function fetchPack(parsed, staging) {
  if (parsed.kind === "file") { copyOrExtract(parsed.path, staging, parsed.name, parsed.subdir); return { resolved: parsed.path, integrity: "file" }; }
  let url = parsed.kind === "github"
    ? `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${encodeURIComponent(parsed.ref)}`
    : `https://registry.npmjs.org/${encodeURIComponent(parsed.package).replace("%2F", "/")}`;
  let response;
  try { response = await fetch(url); } catch (error) { throw new Error(`Unable to fetch ${parsed.kind} pack while offline: ${error.message}`); }
  if (!response.ok) throw new Error(`Unable to fetch pack ${parsed.kind} (${response.status}): ${url}`);
  let bytes;
  if (parsed.kind === "npm") {
    const metadata = await response.json();
    // A requested "version" may be a dist-tag (latest, next, beta, …) — npm
    // resolves dist-tags first, then exact versions.
    const version = metadata["dist-tags"]?.[parsed.version] ?? parsed.version;
    const tarball = metadata.versions?.[version]?.dist?.tarball;
    if (!tarball) throw new Error(`npm pack version not found: ${parsed.package}@${parsed.version}`);
    parsed.version = version;
    try { response = await fetch(tarball); } catch (error) { throw new Error(`Unable to fetch npm pack while offline: ${error.message}`); }
    if (!response.ok) throw new Error(`Unable to fetch npm pack tarball (${response.status}): ${tarball}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } else bytes = Buffer.from(await response.arrayBuffer());
  const archive = `${staging}.tgz`; writeFileSync(archive, bytes);
  validateArchiveManifest(archive, parsed.name, parsed.subdir);
  copyOrExtract(archive, staging, parsed.name, parsed.subdir); rmSync(archive, { force: true });
  const resolved = parsed.kind === "github"
    ? await resolveGithubSha(parsed.owner, parsed.repo, parsed.ref)
    : parsed.version;
  return { resolved, integrity: `sha256-${createHash("sha256").update(bytes).digest("hex")}` };
}

export async function addPack(spec, { from = process.cwd(), global = false, yes = false, subdir = "" } = {}) {
  const parsed = parsePackSpec(spec);
  if (parsed.kind === "file") {
    try { if (lstatSync(parsed.path).isSymbolicLink()) throw new Error(`Pack contains an unsupported symlink: ${parsed.path}`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  // file: archives have no spec-embedded subdir; allow callers to name one.
  if (subdir && !parsed.subdir) parsed.subdir = subdir;
  const temp = mkdtempSync(join(resolve(from), ".smithers-pack-")); const staging = join(temp, "pack");
  try {
    const fetched = await fetchPack(parsed, staging);
    const sourceRoot = parsed.subdir ? join(staging, parsed.subdir) : staging;
    let manifest;
    try { manifest = loadManifest(join(sourceRoot, "smithers.toon")); }
    catch (error) {
      if (!String(error?.message ?? error).includes("missing required name")) throw error;
      const source = readFileSync(join(sourceRoot, "smithers.toon"), "utf8");
      manifest = parseManifest(`name: ${parsed.name}\n${source}`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.name)) throw new Error(`Invalid smithers pack name: ${manifest.name}`);
    assertNoSymlinks(sourceRoot);
    scanPackImports(sourceRoot);
    const workflowTrust = [];
    const workflowDir = join(sourceRoot, "workflows");
    if (existsSync(workflowDir)) {
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const file = join(dir, entry.name);
          if (entry.isDirectory()) walk(file);
          else if (/\.tsx$/.test(entry.name)) {
            const source = readFileSync(file, "utf8");
            const frontmatter = parseWorkflowFrontmatter(source);
            const parseList = (key) => {
              const value = frontmatter[key] ?? source.match(new RegExp(`^//\\s*smithers-${key}:\\s*(.+)$`, "m"))?.[1];
              if (Array.isArray(value)) return value;
              return typeof value === "string" ? value.replace(/^\[(.*)\]$/, "$1").split(",").map((item) => item.trim()).filter(Boolean) : [];
            };
            const requiredOs = parseList("required-os");
            const requiredBins = parseList("required-bins");
            const requiredEnv = parseList("required-env");
            const eligibility = evaluateEligibility({
              requiredOs,
              requiredBins,
              requiredEnv,
            }, process.env);
            if (requiredOs.length || requiredBins.length || requiredEnv.length) {
              workflowTrust.push(`${entry.name}: ${eligibility.eligible ? "eligible" : eligibility.ineligibleReasons.join("; ")}`);
            }
          }
        }
      };
      walk(workflowDir);
    }
    const report = `Pack ${manifest.name} (${manifest.version})\nCapabilities: bins=${manifest.capabilities.bins.join(",") || "none"}, env=${manifest.capabilities.env.join(",") || "none"}, writes=${manifest.capabilities.writes}${workflowTrust.length ? `\nWorkflows: ${workflowTrust.join("; ")}` : ""}`;
    if (!yes && !(process.stdin.isTTY && process.stdout.isTTY)) throw new Error(`${report}\nConfirmation required; pass --yes in non-interactive mode`);
    if (!yes) {
      process.stderr.write(`${report}\n`);
      // One line from the terminal — readFileSync(0) would block until EOF,
      // which an interactive `y⏎` never sends.
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = (await rl.question(`Install ${manifest.name}? [y/N] `)).trim().toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") throw new Error("Pack installation cancelled");
    }
    const root = packRoot(from, global); const target = join(root, manifest.name);
    assertNoInstalledSymlinks(target);
    mkdirSync(root, { recursive: true });
    const merged = join(root, `.${manifest.name}.staging-${process.pid}-${Date.now()}`);
    const backup = join(root, `.${manifest.name}.backup-${process.pid}-${Date.now()}`);
    rmSync(merged, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true });
    try {
      if (existsSync(target)) cpSync(target, merged, { recursive: true }); else mkdirSync(merged, { recursive: true });
      overlayTree(sourceRoot, merged);
      if (existsSync(target)) {
        rmSync(backup, { recursive: true, force: true });
        // The backup and replacement are siblings, so the swap is same-filesystem.
        renameSync(target, backup);
      }
      try { renameSync(merged, target); }
      catch (error) {
        if (existsSync(backup)) renameSync(backup, target);
        throw error;
      }
      const lock = readLock(root); lock[manifest.name] = { spec, ...(parsed.subdir ? { subdir: parsed.subdir } : {}), resolved: fetched.resolved, version: manifest.version, integrity: fetched.integrity }; writeLock(root, lock);
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (lstatSyncSafe(target)) rmSync(target, { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, target);
      throw error;
    } finally { rmSync(merged, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true }); }
    return { name: manifest.name, manifest, report, scope: global ? "global" : "local", path: target };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function removePack(name, { from = process.cwd(), global = false } = {}) {
  const root = packRoot(from, global); const target = join(root, name); if (!existsSync(target)) throw new Error(`Pack not found: ${name}`);
  rmSync(target, { recursive: true, force: true }); const lock = readLock(root); delete lock[name]; writeLock(root, lock); return { name, removed: true, scope: global ? "global" : "local" };
}

export function listPacks(from = process.cwd()) {
  return [false, true].flatMap((global) => { const root = packRoot(from, global); if (!existsSync(root)) return []; return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(root, e.name, "smithers.toon"))).map((e) => ({ name: e.name, scope: global ? "global" : "local", path: join(root, e.name), manifest: loadManifest(join(root, e.name, "smithers.toon")) })); });
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveModuleFile(file) {
  const candidates = [
    file,
    `${file}.ts`, `${file}.tsx`, `${file}.js`, `${file}.jsx`, `${file}.json`, `${file}.md`, `${file}.mdx`,
    `${file}.css`, `${file}.scss`, `${file}.sass`, `${file}.less`, `${file}.svg`, `${file}.png`, `${file}.jpg`, `${file}.jpeg`, `${file}.gif`,
    join(file, "index.ts"), join(file, "index.tsx"), join(file, "index.js"), join(file, "index.jsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile()) ?? null;
}

function localPackDir(from) {
  return dirname(packRoot(from, false));
}

function findInstalledPack(name, from) {
  for (const global of [false, true]) {
    const candidate = join(packRoot(from, global), name);
    if (existsSync(join(candidate, "smithers.toon"))) return candidate;
  }
  throw new Error(`Pack not found: ${name}`);
}

function workflowEntries(root) {
  const workflows = join(root, "workflows");
  if (!existsSync(workflows)) return [];
  const entries = [];
  for (const entry of readdirSync(workflows, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "curated") continue;
    const file = join(workflows, entry.name);
    if (entry.isFile() && entry.name.endsWith(".tsx")) entries.push({ id: entry.name.slice(0, -4), file });
    else if (entry.isDirectory() && existsSync(join(file, "workflow.tsx"))) entries.push({ id: entry.name, file: join(file, "workflow.tsx") });
  }
  return entries;
}

function uiEntries(source) {
  const uiTags = new Set(["UI"]);
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']smithers-orchestrator["']/g)) {
    for (const specifier of match[1].split(",")) {
      const parts = specifier.trim().split(/\s+as\s+/);
      if (parts[0] === "UI") uiTags.add(parts[1] ?? "UI");
    }
  }
  const bindings = new Map([...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])([^"']+)\2/g)].map((match) => [match[1], match[3]]));
  const entries = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "/" && source[index + 1] === "/") { index = source.indexOf("\n", index + 2); if (index < 0) break; continue; }
    if (character === "/" && source[index + 1] === "*") { const end = source.indexOf("*/", index + 2); index = end < 0 ? source.length : end + 2; continue; }
    if (character === "\"" || character === "'" || character === "`") {
      const quote = character; index++;
      while (index < source.length) { if (source[index] === "\\") index += 2; else if (source[index++] === quote) break; }
      continue;
    }
    if (character === "<" && /[A-Za-z_$]/.test(source[index + 1] ?? "")) {
      const tag = source.slice(index + 1).match(/^([A-Za-z_$][\w$]*)/);
      if (tag && uiTags.has(tag[1])) {
        const start = index + 1 + tag[0].length;
        let cursor = start, braces = 0, quote = null;
        for (; cursor < source.length; cursor++) {
          const current = source[cursor];
          if (quote) { if (current === "\\") cursor++; else if (current === quote) quote = null; continue; }
          if (current === "\"" || current === "'") { quote = current; continue; }
          if (current === "{") braces++;
          else if (current === "}") braces--;
          else if (current === ">" && braces === 0) break;
        }
        const attributes = source.slice(start, cursor);
        const entry = attributes.match(/\bentry\s*=\s*(?:(["'])([^"']+)\1|\{\s*(?:(["'])([^"']+)\3|([A-Za-z_$][\w$]*))\s*\})/s);
        if (entry) entries.push(entry[2] ?? entry[4] ?? bindings.get(entry[5]));
        index = cursor + 1;
        continue;
      }
    }
    index++;
  }
  return entries.filter((entry) => typeof entry === "string");
}

// Script modules lex strictly; markdown/MDX lexes tolerantly (its imports are
// real under the MDX plugin, but plain prose need not parse as TSX); CSS is
// scanned for url()/@import references; anything else (images, json, svg,
// fonts, …) is a closure LEAF: copied verbatim, never parsed.
const LEXABLE_MODULE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const MARKDOWN_MODULE = /\.(?:md|mdx)$/;
const CSS_MODULE = /\.(?:css|scss|sass|less)$/;

function cssReferences(source) {
  const names = [];
  // @use/@forward are the Sass module system; @import covers CSS and Less.
  for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)|@(?:import|use|forward)\s+["']([^"']+)["']/g)) {
    const name = match[1] ?? match[2];
    if (name && !/^(?:https?:)?\/\//.test(name) && !name.startsWith("data:")) names.push(name);
  }
  return names;
}

function fileReferences(file, source) {
  if (LEXABLE_MODULE.test(file)) return [...moduleImports(file, source).filter((name) => name.startsWith(".")), ...uiEntries(source)];
  if (MARKDOWN_MODULE.test(file)) {
    try { return moduleImports(file, source).filter((name) => name.startsWith(".")); }
    catch { return []; }
  }
  if (CSS_MODULE.test(file)) {
    // In stylesheets, url("logo.png") and @use "util" are relative to the
    // sheet even without a leading "./".
    return cssReferences(source)
      .filter((name) => !isAbsolute(name))
      .map((name) => (name.startsWith(".") ? name : `./${name}`));
  }
  return [];
}

function referencedFiles(packDir, workflowFile) {
  const files = new Set([workflowFile]);
  const queue = [workflowFile];
  while (queue.length) {
    const file = queue.shift();
    const references = fileReferences(file, readFileSync(file, "utf8"));
    for (const name of references) {
      const cleanName = name.split(/[?#]/, 1)[0];
      const resolved = resolveModuleFile(resolve(dirname(file), cleanName));
      if (!resolved) {
        throw new Error(`Pack workflow references a missing or out-of-pack file: ${file} -> ${name}`);
      }
      if (lstatSync(resolved).isSymbolicLink()) {
        throw new Error(`Pack workflow references an unsupported symlink: ${file} -> ${name}`);
      }
      if (!isWithin(realpathSync(packDir), realpathSync(resolved))) {
        throw new Error(`Pack workflow references a missing or out-of-pack file: ${file} -> ${name}`);
      }
      if (!files.has(resolved)) {
        files.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return files;
}

/** Copy a pack workflow and its relative UI/prompt/lib closure into the local pack. */
export function ejectPack(spec, { from = process.cwd() } = {}) {
  if (typeof spec !== "string" || !spec.trim()) throw new Error("Pack workflow is required (expected <pack>:<workflow>)");
  const match = spec.trim().match(/^([^:]+):(.+)$/);
  if (!match) throw new Error(`Invalid pack workflow: ${spec}. Expected <pack>:<workflow>`);
  const [, packName, workflowId] = match;
  const packDir = findInstalledPack(packName, from);
  const workflow = workflowEntries(packDir).find((entry) => entry.id === workflowId);
  if (!workflow) throw new Error(`Workflow not found in pack ${packName}: ${workflowId}`);
  const files = new Set(referencedFiles(packDir, workflow.file));
  // The Gateway resolves ui/<workflow>.tsx BY CONVENTION, but only for a
  // flat-form workflow that declares no explicit UI — the same eligibility
  // gates the eject closure so an unrelated same-named file is never dragged
  // in (or worse, made a spurious collision).
  const isFlatForm = workflow.file === join(packDir, "workflows", `${workflowId}.tsx`);
  const conventionUi = join(packDir, "ui", `${workflowId}.tsx`);
  if (isFlatForm
    && uiEntries(readFileSync(workflow.file, "utf8")).length === 0
    && existsSync(conventionUi)
    && !files.has(conventionUi)) {
    for (const file of referencedFiles(packDir, conventionUi)) files.add(file);
  }
  const targetRoot = localPackDir(from);
  const copies = [...files].map((source) => ({ source, target: join(targetRoot, relative(packDir, source)) }));
  const collision = copies.find(({ target }) => existsSync(target));
  if (collision) throw new Error(`Cannot eject ${spec}: local target already exists: ${relative(targetRoot, collision.target)}`);
  // Both on-disk workflow forms define the same id — refuse when the OTHER
  // form already exists locally, or discovery becomes ambiguous.
  const flatForm = join(targetRoot, "workflows", `${workflowId}.tsx`);
  const dirForm = join(targetRoot, "workflows", workflowId, "workflow.tsx");
  for (const alternate of [flatForm, dirForm]) {
    if (existsSync(alternate)) {
      throw new Error(`Cannot eject ${spec}: a local workflow with id '${workflowId}' already exists at ${relative(targetRoot, alternate)}`);
    }
  }
  // A parent that exists as a FILE (e.g. a stray .smithers/ui file) would fail
  // mid-copy and strand a partial shadow — refuse before writing anything.
  for (const { target } of copies) {
    for (let dir = dirname(target); dir.length > targetRoot.length; dir = dirname(dir)) {
      if (existsSync(dir) && !statSync(dir).isDirectory()) {
        throw new Error(`Cannot eject ${spec}: ${relative(targetRoot, dir)} exists and is not a directory`);
      }
    }
  }
  // Exclusive writes + rollback: a target that appears after the precheck
  // (concurrent eject) throws EEXIST instead of being overwritten, and any
  // failure removes everything this eject already copied so no partial
  // workflow shadow is left behind.
  const written = [];
  try {
    for (const { source, target } of copies) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
      written.push(target);
    }
  } catch (error) {
    for (const target of written.reverse()) rmSync(target, { force: true });
    throw new Error(`Cannot eject ${spec}: ${error?.message ?? error} (rolled back ${written.length} copied file(s))`);
  }
  return { pack: packName, workflow: workflowId, files: copies.map(({ target }) => target), path: join(targetRoot, relative(packDir, workflow.file)) };
}

export async function updatePack(name, { from = process.cwd(), global = false } = {}) {
  const root = packRoot(from, global); const lock = readLock(root); const entry = lock[name];
  if (!entry?.spec) throw new Error(`No lock entry for pack: ${name}`);
  return addPack(entry.spec, { from, global, yes: true, subdir: typeof entry.subdir === "string" ? entry.subdir : "" });
}

export { renderManifest };

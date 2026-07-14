import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, cpSync, mkdtempSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
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

function packRoot(from, global) {
  if (global) return join(process.env.SMITHERS_HOME || join(homedir(), ".smithers"), "packs");
  let dir = resolve(from);
  while (true) {
    const candidate = join(dir, ".smithers");
    if (existsSync(candidate)) return join(candidate, "packs");
    const parent = dirname(dir);
    if (parent === dir) return join(resolve(from), ".smithers", "packs");
    dir = parent;
  }
}

export function packDirs(from = process.cwd(), global = false) { return packRoot(from, global); }
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

export function scanPackImports(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(file);
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
    const root = packRoot(from, global); const target = join(root, manifest.name); rmSync(target, { recursive: true, force: true }); mkdirSync(root, { recursive: true }); cpSync(sourceRoot, target, { recursive: true });
    const lock = readLock(root); lock[manifest.name] = { spec, ...(parsed.subdir ? { subdir: parsed.subdir } : {}), resolved: fetched.resolved, version: manifest.version, integrity: fetched.integrity }; writeLock(root, lock);
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
    join(file, "index.ts"), join(file, "index.tsx"), join(file, "index.js"), join(file, "index.jsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
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

function referencedFiles(packDir, workflowFile) {
  const files = new Set([workflowFile]);
  const queue = [workflowFile];
  while (queue.length) {
    const file = queue.shift();
    const source = readFileSync(file, "utf8");
    const imports = /\.(?:[cm]?[jt]sx?)$/.test(file)
      ? moduleImports(file, source).filter((name) => name.startsWith("."))
      : [];
    const uiEntries = [...source.matchAll(/<UI\s+entry=["']([^"']+)["']/g)].map((match) => match[1]);
    for (const name of [...imports, ...uiEntries]) {
      const resolved = resolveModuleFile(resolve(dirname(file), name));
      if (!resolved || !isWithin(packDir, resolved)) {
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
  const files = [...referencedFiles(packDir, workflow.file)];
  const targetRoot = localPackDir(from);
  const copies = files.map((source) => ({ source, target: join(targetRoot, relative(packDir, source)) }));
  const collision = copies.find(({ target }) => existsSync(target));
  if (collision) throw new Error(`Cannot eject ${spec}: local target already exists: ${relative(targetRoot, collision.target)}`);
  for (const { source, target } of copies) {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
  return { pack: packName, workflow: workflowId, files: copies.map(({ target }) => target), path: join(targetRoot, relative(packDir, workflow.file)) };
}

export async function updatePack(name, { from = process.cwd(), global = false } = {}) {
  const root = packRoot(from, global); const lock = readLock(root); const entry = lock[name];
  if (!entry?.spec) throw new Error(`No lock entry for pack: ${name}`);
  return addPack(entry.spec, { from, global, yes: true, subdir: typeof entry.subdir === "string" ? entry.subdir : "" });
}

export { renderManifest };

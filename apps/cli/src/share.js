import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadManifest, renderManifest } from "./manifest.js";
import { parseWorkflowFrontmatter } from "./workflows.js";

const REGISTRY_REPO = "smithersai/awesome-smithers";
const PRIVATE_ROOT_NAMES = new Set(["runs", "logs", "node_modules", "state", "executions", "agents", "agents.ts", "CLAUDE.md", "AGENTS.md", ".claude", ".codex", ".env"]);

function findPackRoot(from = process.cwd()) {
  let dir = resolve(from);
  while (true) {
    if (existsSync(join(dir, "smithers.toon"))) return dir;
    const candidate = join(dir, ".smithers");
    if (existsSync(join(candidate, "smithers.toon"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("No smithers.toon found in this pack or its parent project");
    dir = parent;
  }
}

export { findPackRoot };

export function normalizeGithubRepo(repository) {
  const value = String(repository ?? "").trim()
    .replace(/^(?:https?|git):\/\//, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^www\.github\.com\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git\/?$/, "").replace(/\/$/, "");
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(value) ? value : null;
}

export function resolveShareRepositories({ repository, manifestRepository, registry } = {}) {
  const effectiveRepository = normalizeGithubRepo(repository === undefined ? manifestRepository : repository);
  if (!effectiveRepository) throw new Error("Pack repository must be a GitHub repository (owner/name)");
  const effectiveRegistry = normalizeGithubRepo(registry === undefined ? REGISTRY_REPO : registry);
  if (!effectiveRegistry) throw new Error("Registry must be a GitHub repository (owner/name)");
  return { repository: effectiveRepository, registry: effectiveRegistry };
}

/** Escape a value for a Markdown table cell: pipes break columns, newlines
 * break rows. */
function markdownCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function workflowDescriptions(root, manifest) {
  // Mirror the pack discovery semantics (packs.js workflowEntries): a flat
  // workflows/<id>.tsx or a directory-form workflows/<id>/workflow.tsx —
  // both define the id `<id>`.
  const workflows = [];
  const dir = join(root, "workflows");
  if (existsSync(dir)) {
    for (const entry of requireFsReaddir(dir)) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "curated") continue;
      let id;
      let file;
      if (entry.isFile() && entry.name.endsWith(".tsx")) {
        id = entry.name.slice(0, -4);
        file = join(dir, entry.name);
      } else if (entry.isDirectory() && existsSync(join(dir, entry.name, "workflow.tsx"))) {
        id = entry.name;
        file = join(dir, entry.name, "workflow.tsx");
      } else continue;
      if (manifest.contents.workflows.length && !manifest.contents.workflows.includes(id)) continue;
      const source = readFileSync(file, "utf8");
      const frontmatter = parseWorkflowFrontmatter(source);
      const description = frontmatter.description ?? source.match(/^\/\/\s*smithers-description:\s*(.+)$/m)?.[1] ?? `Workflow ${id}`;
      workflows.push({ id, description: markdownCell(description) });
    }
  }
  return workflows.sort((a, b) => a.id.localeCompare(b.id));
}

// Keep the import local to make the module easy to exercise in a plain Node
// test and to avoid exposing fs internals as part of the public helper API.
function requireFsReaddir(path) {
  return readdirSync(path, { withFileTypes: true });
}

export function buildPackEntry(root, { manifest = loadManifest(join(root, "smithers.toon")), repository } = {}) {
  const effectiveRepository = resolveShareRepositories({ repository, manifestRepository: manifest.repository }).repository;
  const workflows = workflowDescriptions(root, manifest);
  const workflowText = workflows.length
    ? workflows.map(({ id, description }) => `\`${id}\`: ${description}`).join("; ")
    : "No workflows listed";
  const install = `smithers add ${effectiveRepository}`;
  const entry = `| [${markdownCell(manifest.name)}](https://github.com/${effectiveRepository}) | ${markdownCell(manifest.description || "Workflow pack")} | \`${install}\` | ${workflowText} |`;
  return { name: manifest.name, description: manifest.description, repository: effectiveRepository, install, workflows, entry };
}

export function updatePacksSection(readme, entry) {
  const heading = /(^##+\s+Packs\s*$)/im;
  const match = heading.exec(readme);
  const tableHeader = "| Pack | Description | Install | Workflows |\n| --- | --- | --- | --- |";
  if (!match) return `${readme.replace(/\s*$/, "")}\n\n## Packs\n\n${tableHeader}\n${entry}\n`;
  const start = match.index + match[0].length;
  const next = readme.slice(start).search(/^##+\s+/m);
  const end = next < 0 ? readme.length : start + next;
  const section = readme.slice(start, end);
  const lines = section.split("\n");
  const name = entry.match(/^\|\s*\[([^\]]+)\](?:\([^)]*\))?\s*\|/)?.[1];
  const matching = name ? lines.flatMap((line, index) => /^\|\s*\[([^\]]+)\](?:\([^)]*\))?\s*\|/.exec(line)?.[1] === name ? [index] : []) : [];
  if (matching.length) {
    lines[matching[0]] = entry;
    for (const index of matching.slice(1).reverse()) lines.splice(index, 1);
  }
  else {
    const header = lines.findIndex((line) => /^\|\s*Pack\s*\|/i.test(line));
    lines.splice(header >= 0 ? header + 2 : 0, 0, ...(header >= 0 ? [entry] : [tableHeader, entry]));
  }
  return `${readme.slice(0, start)}${lines.join("\n")}${readme.slice(end)}`;
}

function isPrivateRootName(name) {
  return name.startsWith("smithers.db") || PRIVATE_ROOT_NAMES.has(name) || name.startsWith(".env.");
}

/** Copy the pack into a fresh staging directory, EXCLUDING private files.
 * Publishing must never mutate the user's live .smithers — deleting
 * smithers.db/node_modules/agents.ts in place would destroy run history and
 * break the working pack. */
export function stagePackForShare(root) {
  const staging = mkdtempSync(join(tmpdir(), "smithers-share-stage-"));
  const excluded = [];
  for (const name of readdirSyncSafe(root)) {
    if (isPrivateRootName(name)) { excluded.push(name); continue; }
    cpSync(join(root, name), join(staging, name), { recursive: true });
  }
  return { staging, excluded };
}

function readdirSyncSafe(root) {
  return requireFsReaddir(root).map((entry) => entry.name);
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function unifiedDiff(before, after) {
  if (before === after) return "";
  const lines = ["--- a/README.md", "+++ b/README.md"];
  for (const line of before.split("\n")) lines.push(`-${line}`);
  for (const line of after.split("\n")) lines.push(`+${line}`);
  return lines.join("\n");
}

/** Read the registry's current README without pushing anything: gh api when
 * authenticated, raw.githubusercontent otherwise, empty when offline. */
export function fetchRegistryReadme(registry) {
  try {
    const base64 = execFileSync("gh", ["api", `repos/${registry}/readme`, "--jq", ".content"], { encoding: "utf8" });
    return { readme: Buffer.from(base64, "base64").toString("utf8"), source: "gh api" };
  } catch { /* fall through */ }
  try {
    const raw = execFileSync("curl", ["-fsSL", `https://raw.githubusercontent.com/${registry}/HEAD/README.md`], { encoding: "utf8" });
    return { readme: raw, source: "raw.githubusercontent.com" };
  } catch { /* fall through */ }
  return { readme: "", source: "unavailable (offline?) — diff shown against an empty README" };
}

export function sharePack({ from = process.cwd(), repo = REGISTRY_REPO, repository, dryRun = false, registryReadme } = {}) {
  const root = findPackRoot(from);
  assertNoSymlinks(root);
  const manifest = loadManifest(join(root, "smithers.toon"));
  const { repository: effectiveRepository, registry } = resolveShareRepositories({ repository, manifestRepository: manifest.repository, registry: repo ?? REGISTRY_REPO });
  const pack = buildPackEntry(root, { manifest, repository: effectiveRepository });
  if (dryRun) {
    // Diff against the ACTUAL registry README so the dry run shows whether a
    // row is added or replaced; callers (tests) may inject one explicitly.
    const fetched = registryReadme === undefined ? fetchRegistryReadme(registry) : { readme: registryReadme, source: "provided" };
    const updated = updatePacksSection(fetched.readme, pack.entry);
    return { dryRun: true, entry: pack.entry, diff: unifiedDiff(fetched.readme, updated), registrySource: fetched.source, manifest: pack, repository: pack.repository, registry };
  }

  try { execFileSync("gh", ["auth", "status"], { stdio: "ignore" }); }
  catch { throw new Error("The `gh` CLI is required and must be authenticated (`gh auth login`) to share a pack"); }
  const temp = join(homedir(), `.smithers-share-${Date.now()}`);
  mkdirSync(temp, { recursive: true });
  try {
    const branch = `smithers/share-${manifest.name.replace(/[^A-Za-z0-9._-]+/g, "-")}-${Date.now()}`;
    execFileSync("gh", ["repo", "fork", registry, "--clone"], { cwd: temp, stdio: "inherit" });
    const checkout = join(temp, basename(registry));
    execFileSync("git", ["switch", "--create", branch], { cwd: checkout, stdio: "inherit" });
    const registryReadme = join(checkout, "README.md");
    const registryOriginal = readFileSync(registryReadme, "utf8");
    const registryUpdated = updatePacksSection(registryOriginal, pack.entry);
    if (registryOriginal === registryUpdated) {
      return { ...pack, registry, unchanged: true };
    }
    writeFileSync(registryReadme, registryUpdated);
    execFileSync("git", ["add", "README.md"], { cwd: checkout, stdio: "inherit" });
    execFileSync("git", ["commit", "-m", `docs: add ${manifest.name} pack`], { cwd: checkout, stdio: "inherit" });
    execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: checkout, stdio: "inherit" });
    const pr = execFileSync("gh", ["pr", "create", "--repo", registry, "--head", branch, "--title", `docs: add ${manifest.name} pack`, "--body", `Add the ${manifest.name} workflow pack to the registry.`], { cwd: checkout, encoding: "utf8" }).trim();
    return { ...pack, registry, pullRequest: pr };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** Build the publishable staging copy: private files excluded, manifest
 * repository set, README ensured. The live pack root is never written. */
export function preparePackForShare({ from = process.cwd(), repository } = {}) {
  const root = findPackRoot(from);
  assertNoSymlinks(root);
  const manifest = loadManifest(join(root, "smithers.toon"));
  const effectiveRepository = resolveShareRepositories({ repository, manifestRepository: manifest.repository }).repository;
  const { staging, excluded } = stagePackForShare(root);
  writeFileSync(join(staging, "smithers.toon"), renderManifest({ ...manifest, repository: effectiveRepository }));
  const readmePath = join(staging, "README.md");
  const oldRepository = normalizeGithubRepo(manifest.repository);
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, `# ${manifest.name}\n\n${manifest.description || "A Smithers workflow pack."}\n\nInstall with \`smithers add ${effectiveRepository}\`.\n`);
  } else if (oldRepository && oldRepository !== effectiveRepository) {
    const readme = readFileSync(readmePath, "utf8");
    const updated = readme
      .replace(new RegExp(`(Install with\\s+)${escapeRegExp(oldRepository)}(?=[\\s.!?)]|$)`, "g"), `$1${effectiveRepository}`)
      .replace(new RegExp("(smithers add\\s+)" + escapeRegExp(oldRepository) + "(?=[\\s.)`]|$)", "g"), `$1${effectiveRepository}`);
    if (updated !== readme) writeFileSync(readmePath, updated);
  }
  return {
    detail: `staged ${manifest.name} for publication (${excluded.length} private path(s) excluded; live pack untouched)`,
    stagingRoot: staging,
    excluded,
  };
}

export function publishPackRepository({ from = process.cwd(), repository, stagingRoot } = {}) {
  const root = findPackRoot(from);
  const manifest = loadManifest(join(root, "smithers.toon"));
  const effectiveRepository = resolveShareRepositories({ repository, manifestRepository: manifest.repository }).repository;
  try { execFileSync("gh", ["auth", "status"], { stdio: "ignore" }); }
  catch { throw new Error("The `gh` CLI is required and must be authenticated (`gh auth login`) to publish a pack"); }
  // Publish the STAGED copy, never the live pack root (which contains run
  // state, credentials scaffolding, and node_modules).
  const staged = stagingRoot && existsSync(stagingRoot)
    ? stagingRoot
    : preparePackForShare({ from, repository }).stagingRoot;
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: staged, stdio: "inherit" });
    execFileSync("git", ["add", "-A"], { cwd: staged, stdio: "inherit" });
    execFileSync("git", ["commit", "--quiet", "-m", `feat: publish ${manifest.name} workflow pack`], { cwd: staged, stdio: "inherit" });
    execFileSync("gh", ["repo", "create", effectiveRepository, "--public", "--source", staged, "--remote", "origin", "--push"], { cwd: staged, stdio: "inherit" });
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  return `published ${effectiveRepository} from a staged copy`;
}

function assertNoSymlinks(root) {
  if (lstatSync(root).isSymbolicLink()) throw new Error(`Pack contains an unsupported symlink: ${root}`);
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name);
      if (lstatSync(file).isSymbolicLink()) throw new Error(`Pack contains an unsupported symlink: ${file}`);
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(root);
}

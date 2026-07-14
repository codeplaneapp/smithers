import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadManifest } from "./manifest.js";
import { parseWorkflowFrontmatter } from "./workflows.js";

const REGISTRY_REPO = "smithersai/awesome-smithers";
const PRIVATE_NAMES = new Set(["runs", "logs", "node_modules", "state", "executions"]);

function findSmithersRoot(from = process.cwd()) {
  let dir = resolve(from);
  while (true) {
    const candidate = join(dir, ".smithers");
    if (existsSync(join(candidate, "smithers.toon"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("No .smithers/smithers.toon found in this project or its parents");
    dir = parent;
  }
}

function githubRepo(repository) {
  const value = String(repository ?? "").trim().replace(/^https?:\/\//, "").replace(/^git@github\.com:/, "").replace(/^github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  return /^[^/]+\/[^/]+$/.test(value) ? value : null;
}

function workflowDescriptions(root, manifest) {
  const workflows = [];
  const dir = join(root, "workflows");
  const visit = (current, prefix = "") => {
    if (!existsSync(current)) return;
    for (const entry of requireFsReaddir(current)) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) visit(file, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".tsx")) {
        const id = `${prefix}${entry.name.slice(0, -4)}`;
        if (manifest.contents.workflows.length && !manifest.contents.workflows.includes(id)) continue;
        const source = readFileSync(file, "utf8");
        const frontmatter = parseWorkflowFrontmatter(source);
        const description = frontmatter.description ?? source.match(/^\/\/\s*smithers-description:\s*(.+)$/m)?.[1] ?? `Workflow ${id}`;
        workflows.push({ id, description: String(description).trim() });
      }
    }
  };
  visit(dir);
  return workflows.sort((a, b) => a.id.localeCompare(b.id));
}

// Keep the import local to make the module easy to exercise in a plain Node
// test and to avoid exposing fs internals as part of the public helper API.
function requireFsReaddir(path) {
  return readdirSync(path, { withFileTypes: true });
}

export function buildPackEntry(root, { manifest = loadManifest(join(root, "smithers.toon")) } = {}) {
  const repository = githubRepo(manifest.repository);
  if (!repository) throw new Error("smithers.toon must contain a GitHub repository (owner/name) before sharing");
  const workflows = workflowDescriptions(root, manifest);
  const workflowText = workflows.length
    ? workflows.map(({ id, description }) => `\`${id}\`: ${description}`).join("; ")
    : "No workflows listed";
  const install = `smithers add ${repository}`;
  const entry = `| [${manifest.name}](https://github.com/${repository}) | ${manifest.description || "Workflow pack"} | \`${install}\` | ${workflowText} |`;
  return { name: manifest.name, description: manifest.description, repository, install, workflows, entry };
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
  const existing = new RegExp(`^\\|\\s*(?:\\[[^]]+\\]|${escapeRegExp(entry.split("|")[1].trim())})\\s*\\|`);
  const row = lines.findIndex((line) => existing.test(line));
  if (row >= 0) lines[row] = entry;
  else {
    const header = lines.findIndex((line) => /^\|\s*Pack\s*\|/i.test(line));
    lines.splice(header >= 0 ? header + 2 : 0, 0, ...(header >= 0 ? [entry] : [tableHeader, entry]));
  }
  return `${readme.slice(0, start)}${lines.join("\n")}${readme.slice(end)}`;
}

export function stripPrivateFiles(root) {
  const removed = [];
  for (const name of readdirSyncSafe(root)) {
    if (name.startsWith("smithers.db") || PRIVATE_NAMES.has(name)) {
      rmSync(join(root, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

function readdirSyncSafe(root) {
  return requireFsReaddir(root).map((entry) => entry.name);
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function sharePack({ from = process.cwd(), repo = REGISTRY_REPO, dryRun = false } = {}) {
  const root = findSmithersRoot(from);
  const manifest = loadManifest(join(root, "smithers.toon"));
  const pack = buildPackEntry(root, { manifest });
  const readmePath = join(root, "..", "README.md");
  const original = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
  const updated = updatePacksSection(original, pack.entry);
  const diff = original === updated ? "" : `--- README.md\n+++ README.md\n${updated.split("\n").map((line, i) => `${original.split("\n")[i] === line ? " " : "+"}${line}`).join("\n")}`;
  if (dryRun) return { dryRun: true, entry: pack.entry, diff, manifest: pack, repository: repo ?? REGISTRY_REPO };

  try { execFileSync("gh", ["auth", "status"], { stdio: "ignore" }); }
  catch { throw new Error("The `gh` CLI is required and must be authenticated (`gh auth login`) to share a pack"); }
  const temp = join(homedir(), `.smithers-share-${Date.now()}`);
  mkdirSync(temp, { recursive: true });
  try {
    const registry = repo ?? REGISTRY_REPO;
    execFileSync("gh", ["repo", "fork", registry, "--clone"], { cwd: temp, stdio: "inherit" });
    const checkout = join(temp, basename(registry));
    const registryReadme = join(checkout, "README.md");
    const registryOriginal = readFileSync(registryReadme, "utf8");
    writeFileSync(registryReadme, updatePacksSection(registryOriginal, pack.entry));
    execFileSync("git", ["add", "README.md"], { cwd: checkout, stdio: "inherit" });
    execFileSync("git", ["commit", "-m", `docs: add ${manifest.name} pack`], { cwd: checkout, stdio: "inherit" });
    execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: checkout, stdio: "inherit" });
    const pr = execFileSync("gh", ["pr", "create", "--repo", registry, "--title", `docs: add ${manifest.name} pack`, "--body", `Add the ${manifest.name} workflow pack to the registry.`], { cwd: checkout, encoding: "utf8" }).trim();
    return { ...pack, repository: registry, pullRequest: pr };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function preparePackForShare({ from = process.cwd(), repository } = {}) {
  const root = findSmithersRoot(from);
  const manifest = loadManifest(join(root, "smithers.toon"));
  const removed = stripPrivateFiles(root);
  const readmePath = join(root, "..", "README.md");
  if (!existsSync(readmePath)) {
    const install = githubRepo(repository || manifest.repository) || "owner/repo";
    writeFileSync(readmePath, `# ${manifest.name}\n\n${manifest.description || "A Smithers workflow pack."}\n\nInstall with ${install}.\n`);
  }
  return `prepared ${manifest.name}; removed ${removed.length} private path(s)`;
}

export function publishPackRepository({ from = process.cwd(), repository } = {}) {
  if (!repository) throw new Error("A GitHub repository name is required to publish the pack");
  try { execFileSync("gh", ["auth", "status"], { stdio: "ignore" }); }
  catch { throw new Error("The `gh` CLI is required and must be authenticated (`gh auth login`) to publish a pack"); }
  execFileSync("gh", ["repo", "create", repository, "--public", "--source", from, "--remote", "origin", "--push"], { cwd: from, stdio: "inherit" });
  return `published ${repository}`;
}

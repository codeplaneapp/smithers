import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { decode, encode } from "@toon-format/toon";
import { loadManifest, parseManifest, renderManifest } from "./manifest.js";

const ALLOWED = new Set(["smithers-orchestrator", "react", "zod"]);

export function parsePackSpec(spec) {
  if (typeof spec !== "string" || !spec.trim()) throw new Error("Pack spec is required");
  const raw = spec.trim();
  if (raw.startsWith("github:")) {
    const match = raw.slice(7).match(/^([^/]+)\/([^/#]+)(?:\/([^#]+))?(?:#(.+))?$/);
    if (!match) throw new Error(`Invalid GitHub pack spec: ${raw}`);
    return { kind: "github", owner: match[1], repo: match[2], subdir: match[3] ?? "", ref: match[4] ?? "HEAD", name: match[2] };
  }
  if (/^[^/@]+\/[^/]+$/.test(raw)) {
    const [owner, repo] = raw.split("/");
    return { kind: "github", owner, repo, subdir: "", ref: "HEAD", name: repo };
  }
  const npm = raw.startsWith("npm:") ? raw.slice(4) : raw;
  if (!raw.startsWith("file:") && (raw.startsWith("npm:") || !raw.includes("/") || /^@[^/]+\/[^@]+@/.test(raw))) {
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
export function lockPath(root) { return join(root, "packs.lock.toon"); }
function readLock(root) {
  const path = lockPath(root);
  if (!existsSync(path)) return {};
  const value = decode(readFileSync(path, "utf8"));
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function writeLock(root, value) { mkdirSync(root, { recursive: true }); writeFileSync(lockPath(root), `${encode(value)}\n`); }

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
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bimport\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const name = match[1] ?? match[2];
      if (!name.startsWith(".") && !ALLOWED.has(name) && !name.startsWith("@smithers-orchestrator/")) {
        throw new Error(`Pack import not allowed: ${file} imports ${name}`);
      }
    }
  }
}

function copyOrExtract(source, target) {
  if (existsSync(join(source, "smithers.toon"))) { cpSync(source, target, { recursive: true }); return; }
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", source, "-C", target]);
  const child = readdirSync(target, { withFileTypes: true }).find((entry) => entry.isDirectory());
  if (child && existsSync(join(target, child.name, "smithers.toon"))) {
    const staging = `${target}.flat`; rmSync(staging, { recursive: true, force: true }); cpSync(join(target, child.name), staging, { recursive: true }); rmSync(target, { recursive: true, force: true }); cpSync(staging, target, { recursive: true }); rmSync(staging, { recursive: true, force: true });
  }
}

async function fetchPack(parsed, staging) {
  if (parsed.kind === "file") { copyOrExtract(parsed.path, staging); return { resolved: parsed.path, integrity: "file" }; }
  let url = parsed.kind === "github"
    ? `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${encodeURIComponent(parsed.ref)}`
    : `https://registry.npmjs.org/${encodeURIComponent(parsed.package).replace("%2F", "/")}`;
  let response;
  try { response = await fetch(url); } catch (error) { throw new Error(`Unable to fetch ${parsed.kind} pack while offline: ${error.message}`); }
  if (!response.ok) throw new Error(`Unable to fetch pack ${parsed.kind} (${response.status}): ${url}`);
  let bytes;
  if (parsed.kind === "npm") {
    const metadata = await response.json();
    const version = parsed.version === "latest" ? metadata["dist-tags"]?.latest : parsed.version;
    const tarball = metadata.versions?.[version]?.dist?.tarball;
    if (!tarball) throw new Error(`npm pack version not found: ${parsed.package}@${parsed.version}`);
    parsed.version = version;
    try { response = await fetch(tarball); } catch (error) { throw new Error(`Unable to fetch npm pack while offline: ${error.message}`); }
    if (!response.ok) throw new Error(`Unable to fetch npm pack tarball (${response.status}): ${tarball}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } else bytes = Buffer.from(await response.arrayBuffer());
  const archive = `${staging}.tgz`; writeFileSync(archive, bytes);
  copyOrExtract(archive, staging); rmSync(archive, { force: true });
  return { resolved: parsed.ref ?? parsed.version, integrity: `sha256-${createHash("sha256").update(bytes).digest("hex")}` };
}

export async function addPack(spec, { from = process.cwd(), global = false, yes = false } = {}) {
  const parsed = parsePackSpec(spec); const temp = mkdtempSync(join(resolve(from), ".smithers-pack-")); const staging = join(temp, "pack");
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
            const fields = ["required-os", "required-bins", "required-env"].map((key) => source.match(new RegExp(`^//\\s*smithers-${key}:\\s*(.+)$`, "m"))?.[1]?.trim()).filter(Boolean);
            if (fields.length) workflowTrust.push(`${entry.name}: ${fields.join(", ")}`);
          }
        }
      };
      walk(workflowDir);
    }
    const report = `Pack ${manifest.name} (${manifest.version})\\nCapabilities: bins=${manifest.capabilities.bins.join(",") || "none"}, env=${manifest.capabilities.env.join(",") || "none"}, writes=${manifest.capabilities.writes}${workflowTrust.length ? `\\nWorkflows: ${workflowTrust.join("; ")}` : ""}`;
    if (!yes && !(process.stdin.isTTY && process.stdout.isTTY)) throw new Error(`${report}\nConfirmation required; pass --yes in non-interactive mode`);
    if (!yes) { process.stderr.write(`${report}\nInstall ${manifest.name}? [y/N] `); const answer = readFileSync(0, "utf8").trim().toLowerCase(); if (answer !== "y" && answer !== "yes") throw new Error("Pack installation cancelled"); }
    const root = packRoot(from, global); const target = join(root, manifest.name); rmSync(target, { recursive: true, force: true }); mkdirSync(root, { recursive: true }); cpSync(sourceRoot, target, { recursive: true });
    const lock = readLock(root); lock[manifest.name] = { spec, resolved: fetched.resolved, version: manifest.version, integrity: fetched.integrity }; writeLock(root, lock);
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

export async function updatePack(name, { from = process.cwd(), global = false } = {}) {
  const root = packRoot(from, global); const lock = readLock(root); const entry = lock[name];
  if (!entry?.spec) throw new Error(`No lock entry for pack: ${name}`);
  return addPack(entry.spec, { from, global, yes: true });
}

export { renderManifest };

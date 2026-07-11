#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const SCHEMA_VERSION = 1;
export const MAX_FILES = 2_000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const ALLOWED_PATHS = Object.freeze([
  ".smithers",
  "apps/cli/docs",
  "apps/cli/src/seeded-workflow-pack.generated.js",
  "apps/cli/src/sota-models.generated.js",
  "benchmarks",
  "docs",
  "evals",
  "packages/smithers/docs",
  "scripts",
  "skills/smithers",
]);

function fail(message) {
  throw new Error(`maintenance artifact: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has unsupported fields`);
  }
}

export function assertAllowedPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    !/^[A-Za-z0-9._@+/-]+$/.test(path)
  ) {
    fail(`unsafe path ${JSON.stringify(path)}`);
  }
  const components = path.split("/");
  if (components.some((component) => component === "" || component === "." || component === ".." || component === ".git")) {
    fail(`unsafe path ${JSON.stringify(path)}`);
  }
  if (!ALLOWED_PATHS.some((root) => path === root || path.startsWith(`${root}/`))) {
    fail(`path is outside the publication allowlist: ${path}`);
  }
  return path;
}

function assertSafeRoot(root, label) {
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a real directory`);
}

function assertNoSymlinkComponents(root, path, { allowMissingLeaf = false } = {}) {
  const rootPath = resolve(root);
  let current = rootPath;
  const components = path.split("/");
  for (let index = 0; index < components.length; index += 1) {
    current = resolve(current, components[index]);
    if (relative(rootPath, current).startsWith(`..${sep}`) || current === dirname(rootPath)) {
      fail(`path escaped its root: ${path}`);
    }
    if (!existsSync(current)) {
      if (allowMissingLeaf) return;
      fail(`artifact file is missing: ${path}`);
    }
    const info = lstatSync(current);
    if (info.isSymbolicLink()) fail(`symbolic links are not allowed: ${path}`);
    if (index < components.length - 1 && !info.isDirectory()) {
      fail(`path parent is not a directory: ${path}`);
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) fail(`could not start ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "no output").trim().slice(0, 2_000);
    fail(`${command} failed with exit ${result.status ?? "unknown"}: ${detail}`);
  }
  return result.stdout;
}

function git(args, cwd, options = {}) {
  return run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      ...options.env,
    },
  });
}

function changedPaths(baseDir, sourceDir) {
  const output = git(
    [
      `--git-dir=${resolve(baseDir, ".git")}`,
      `--work-tree=${resolve(sourceDir)}`,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--",
      ...ALLOWED_PATHS,
    ],
    baseDir,
  );
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files = [];
  const deletions = [];

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record.length < 4 || record[2] !== " ") fail("git returned an invalid status record");
    const status = record.slice(0, 2);
    const path = assertAllowedPath(record.slice(3));
    if (status.includes("R") || status.includes("C")) {
      index += 1;
      if (index >= fields.length) fail("git returned an incomplete rename record");
      assertAllowedPath(fields[index]);
      fail("renamed paths are not accepted; publish them as an add and a deletion");
    }
    if (status === "??" || status === " M" || status === " T") files.push(path);
    else if (status === " D") deletions.push(path);
    else fail(`unsupported git status ${JSON.stringify(status)} for ${path}`);
  }

  return {
    files: [...new Set(files)].sort(),
    deletions: [...new Set(deletions)].sort(),
  };
}

function readRegularFile(root, path) {
  assertNoSymlinkComponents(root, path);
  const absolute = resolve(root, path);
  const before = lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail(`changed path must be a regular, singly linked file: ${path}`);
  }
  if (before.size > MAX_FILE_BYTES) fail(`file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
  const bytes = readFileSync(absolute);
  const after = lstatSync(absolute);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    fail(`file changed while it was being packaged: ${path}`);
  }
  return { bytes, mode: before.mode & 0o111 ? "100755" : "100644" };
}

export function packArtifact({ baseDir, sourceDir, outputDir, repository, baseSha, runId, runAttempt }) {
  assertSafeRoot(resolve(baseDir), "base checkout");
  assertSafeRoot(resolve(sourceDir), "analysis checkout");
  if (!/^[0-9a-f]{40}$/.test(baseSha)) fail("base SHA must be a full lowercase commit SHA");
  if (!/^[1-9][0-9]*$/.test(String(runId))) fail("run ID must be a positive integer");
  if (!/^[1-9][0-9]*$/.test(String(runAttempt))) fail("run attempt must be a positive integer");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail("repository must be owner/name");
  if (existsSync(outputDir)) fail("output directory must not already exist");

  const baseHead = git(["rev-parse", "HEAD"], baseDir).trim();
  if (baseHead !== baseSha) fail(`trusted base checkout is ${baseHead}, expected ${baseSha}`);
  const changed = changedPaths(baseDir, sourceDir);
  if (changed.files.length + changed.deletions.length > MAX_FILES) {
    fail(`artifact has more than ${MAX_FILES} changed paths`);
  }

  mkdirSync(resolve(outputDir, "files"), { recursive: true, mode: 0o700 });
  const files = [];
  let totalBytes = 0;
  for (const path of changed.files) {
    const { bytes, mode } = readRegularFile(sourceDir, path);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) fail(`artifact exceeds ${MAX_TOTAL_BYTES} total file bytes`);
    const destination = resolve(outputDir, "files", path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { mode: mode === "100755" ? 0o700 : 0o600, flag: "wx" });
    files.push({ path, size: bytes.length, sha256: sha256(bytes), mode });
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    repository,
    baseSha,
    runId: String(runId),
    runAttempt: String(runAttempt),
    files,
    deletions: changed.deletions,
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES) fail("manifest is too large");
  writeFileSync(resolve(outputDir, "manifest.json"), serialized, { mode: 0o600, flag: "wx" });
  return manifest;
}

function walkArtifact(root) {
  const files = [];
  const directories = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = resolve(directory, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) fail(`artifact contains a symbolic link: ${path}`);
      if (info.isDirectory()) {
        directories.push(path);
        visit(absolute, path);
      } else if (info.isFile() && info.nlink === 1) {
        files.push(path);
      } else {
        fail(`artifact contains a special or multiply linked file: ${path}`);
      }
      if (files.length + directories.length > MAX_FILES * 10) fail("artifact contains too many entries");
    }
  };
  visit(root);
  return { files, directories };
}

function parentDirectories(path) {
  const directories = [];
  let current = dirname(path);
  while (current !== ".") {
    directories.push(current);
    current = dirname(current);
  }
  return directories;
}

export function validateArtifact({ artifactDir, repository, baseSha, runId, runAttempt }) {
  const root = resolve(artifactDir);
  assertSafeRoot(root, "artifact directory");
  assertNoSymlinkComponents(root, "manifest.json");
  const manifestInfo = statSync(resolve(root, "manifest.json"));
  if (!manifestInfo.isFile() || manifestInfo.size > MAX_MANIFEST_BYTES) fail("manifest is missing or too large");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
  } catch (error) {
    fail(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  assertExactKeys(
    manifest,
    ["schemaVersion", "repository", "baseSha", "runId", "runAttempt", "files", "deletions"],
    "manifest",
  );
  if (manifest.schemaVersion !== SCHEMA_VERSION) fail(`unsupported schema version ${manifest.schemaVersion}`);
  if (manifest.repository !== repository) fail("repository binding does not match this workflow run");
  if (manifest.baseSha !== baseSha) fail("base SHA binding does not match this workflow run");
  if (manifest.runId !== String(runId)) fail("run ID binding does not match this workflow run");
  if (manifest.runAttempt !== String(runAttempt)) fail("run attempt binding does not match this workflow run");
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.deletions)) fail("files and deletions must be arrays");
  if (manifest.files.length + manifest.deletions.length > MAX_FILES) fail(`artifact has more than ${MAX_FILES} paths`);

  const paths = new Set();
  let totalBytes = 0;
  let previousPath = "";
  for (const [index, file] of manifest.files.entries()) {
    assertExactKeys(file, ["path", "size", "sha256", "mode"], `files[${index}]`);
    const path = assertAllowedPath(file.path);
    if (path <= previousPath) fail("manifest files must be uniquely sorted by path");
    previousPath = path;
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) {
      fail(`invalid size for ${path}`);
    }
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) fail(`invalid SHA-256 for ${path}`);
    if (file.mode !== "100644" && file.mode !== "100755") fail(`invalid mode for ${path}`);
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_BYTES) fail(`artifact exceeds ${MAX_TOTAL_BYTES} total file bytes`);
    paths.add(path);

    const artifactPath = `files/${path}`;
    assertNoSymlinkComponents(root, artifactPath);
    const info = lstatSync(resolve(root, artifactPath));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== file.size) {
      fail(`artifact metadata does not match ${path}`);
    }
    const bytes = readFileSync(resolve(root, artifactPath));
    if (sha256(bytes) !== file.sha256) fail(`artifact hash does not match ${path}`);
  }

  previousPath = "";
  for (const pathValue of manifest.deletions) {
    const path = assertAllowedPath(pathValue);
    if (path <= previousPath) fail("manifest deletions must be uniquely sorted by path");
    previousPath = path;
    if (paths.has(path)) fail(`path is both a file and a deletion: ${path}`);
    paths.add(path);
  }

  const tree = walkArtifact(root);
  const expectedFiles = ["manifest.json", ...manifest.files.map((file) => `files/${file.path}`)].sort();
  if (JSON.stringify(tree.files.sort()) !== JSON.stringify(expectedFiles)) fail("artifact contains unexpected files");
  const expectedDirectories = new Set(["files"]);
  for (const path of expectedFiles) {
    for (const directory of parentDirectories(path)) expectedDirectories.add(directory);
  }
  if (JSON.stringify(tree.directories.sort()) !== JSON.stringify([...expectedDirectories].sort())) {
    fail("artifact contains unexpected directories");
  }
  return manifest;
}

function ensureCleanCheckout(checkoutDir, baseSha) {
  assertSafeRoot(resolve(checkoutDir), "publisher checkout");
  const head = git(["rev-parse", "HEAD"], checkoutDir).trim();
  if (head !== baseSha) fail(`publisher checkout is ${head}, expected ${baseSha}`);
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], checkoutDir);
  if (status !== "") {
    fail(`publisher checkout must be clean before applying an artifact: ${status.trim().slice(0, 2_000)}`);
  }
}

function prepareDestination(checkoutDir, path) {
  assertNoSymlinkComponents(checkoutDir, dirname(path), { allowMissingLeaf: true });
  const destination = resolve(checkoutDir, path);
  if (existsSync(destination)) {
    const info = lstatSync(destination);
    if (info.isDirectory()) fail(`cannot replace a directory with a file: ${path}`);
    rmSync(destination);
  }
  mkdirSync(dirname(destination), { recursive: true });
  return destination;
}

export function materializeArtifact({ artifactDir, checkoutDir, repository, baseSha, runId, runAttempt }) {
  const manifest = validateArtifact({ artifactDir, repository, baseSha, runId, runAttempt });
  ensureCleanCheckout(checkoutDir, baseSha);

  for (const path of manifest.deletions) {
    assertNoSymlinkComponents(checkoutDir, dirname(path), { allowMissingLeaf: true });
    const destination = resolve(checkoutDir, path);
    if (existsSync(destination)) {
      const info = lstatSync(destination);
      if (info.isDirectory()) fail(`refusing to recursively delete a directory: ${path}`);
      rmSync(destination);
    }
  }
  for (const file of manifest.files) {
    const source = resolve(artifactDir, "files", file.path);
    const destination = prepareDestination(checkoutDir, file.path);
    const sourceFd = openSync(source, "r");
    try {
      writeFileSync(destination, readFileSync(sourceFd), { mode: file.mode === "100755" ? 0o755 : 0o644, flag: "wx" });
    } finally {
      closeSync(sourceFd);
    }
    chmodSync(destination, file.mode === "100755" ? 0o755 : 0o644);
  }

  const expected = [...manifest.files.map((file) => file.path), ...manifest.deletions].sort();
  git(["add", "-A", "--", ...expected], checkoutDir);
  git(["diff", "--cached", "--check"], checkoutDir);
  const staged = git(["diff", "--cached", "--name-only", "-z", "--no-renames"], checkoutDir)
    .split("\0")
    .filter(Boolean)
    .sort();
  if (JSON.stringify(staged) !== JSON.stringify(expected)) {
    fail("staged paths do not exactly match the validated manifest");
  }
  return manifest;
}

function assertMainBinding(checkoutDir, repository, baseSha) {
  const remote = git(["remote", "get-url", "origin"], checkoutDir).trim().replace(/\.git$/, "");
  const pushRemote = git(["remote", "get-url", "--push", "origin"], checkoutDir).trim().replace(/\.git$/, "");
  const accepted = new Set([`https://github.com/${repository}`, `git@github.com:${repository}`]);
  if (!accepted.has(remote) || !accepted.has(pushRemote)) fail(`origin does not point to ${repository}`);
  const output = git(["ls-remote", "--exit-code", "origin", "refs/heads/main"], checkoutDir).trim();
  const currentMain = output.split(/\s+/)[0];
  if (currentMain !== baseSha) fail(`main advanced from ${baseSha} to ${currentMain || "an unknown SHA"}`);
}

export function publishArtifact({ artifactDir, checkoutDir, repository, baseSha, runId, runAttempt }) {
  if (process.env.GITHUB_EVENT_NAME !== "schedule" && process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    fail("publisher only accepts scheduled or manually dispatched runs");
  }
  if (process.env.GITHUB_REF !== "refs/heads/main") fail("publisher only accepts runs from main");
  if (!process.env.GH_TOKEN) fail("publisher requires GH_TOKEN");
  const manifest = materializeArtifact({ artifactDir, checkoutDir, repository, baseSha, runId, runAttempt });
  if (manifest.files.length + manifest.deletions.length === 0) fail("empty artifacts cannot be published");
  assertMainBinding(checkoutDir, repository, baseSha);

  const branch = `daily/smithers-maintenance-${runId}-${runAttempt}`;
  const subject = `🔧 chore(maintenance): refresh generated artifacts ${runId}`;
  const body = [
    "# Daily Smithers maintenance",
    "",
    `Run: ${runId} (attempt ${runAttempt})`,
    `Base: ${baseSha}`,
    "",
    "Review the generated benchmark, evaluation, and documentation updates before merging.",
    `Workflow run: https://github.com/${repository}/actions/runs/${runId}`,
  ].join("\n");

  git(["checkout", "-b", branch], checkoutDir);
  git(["-c", "user.name=smithers-maintenance", "-c", "user.email=bot@smithers.sh", "commit", "-m", subject], checkoutDir);
  git(
    [
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "origin",
      `HEAD:refs/heads/${branch}`,
    ],
    checkoutDir,
    { env: process.env },
  );
  run(
    "gh",
    ["pr", "create", "--repo", repository, "--title", subject, "--body", body, "--base", "main", "--head", branch],
    { cwd: checkoutDir, env: process.env },
  );
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== "pack" && command !== "publish" && command !== "validate") fail("expected pack, validate, or publish");
  const values = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail(`invalid argument ${key ?? "(missing)"}`);
    values[key.slice(2)] = value;
  }
  return values;
}

function requireArgument(values, name) {
  if (typeof values[name] !== "string" || values[name] === "") fail(`--${name} is required`);
  return values[name];
}

function main() {
  const values = parseArguments(process.argv.slice(2));
  const common = {
    repository: requireArgument(values, "repository"),
    baseSha: requireArgument(values, "base-sha"),
    runId: requireArgument(values, "run-id"),
    runAttempt: requireArgument(values, "run-attempt"),
  };
  if (values.command === "pack") {
    const manifest = packArtifact({
      ...common,
      baseDir: requireArgument(values, "base"),
      sourceDir: requireArgument(values, "source"),
      outputDir: requireArgument(values, "output"),
    });
    const output = requireArgument(values, "github-output");
    const artifactName = requireArgument(values, "artifact-name");
    if (!/^[A-Za-z0-9._-]+$/.test(artifactName)) fail("artifact name has unsafe characters");
    writeFileSync(
      output,
      `has_changes=${manifest.files.length + manifest.deletions.length > 0}\nartifact_name=${artifactName}\n`,
      { flag: "a" },
    );
    return;
  }
  const options = {
    ...common,
    artifactDir: requireArgument(values, "artifact"),
  };
  if (values.command === "validate") {
    validateArtifact(options);
    return;
  }
  publishArtifact({ ...options, checkoutDir: requireArgument(values, "checkout") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

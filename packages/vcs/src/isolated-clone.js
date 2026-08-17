import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { resolveGitBinary } from "./resolveGitBinary.js";
/** @typedef {import("./IsolatedClone.ts").GitRef} GitRef */
/** @typedef {import("./IsolatedClone.ts").IsolatedCloneCapsule} IsolatedCloneCapsule */
/** @typedef {import("./IsolatedClone.ts").StreamingProcessResult} StreamingProcessResult */

const MARKER = ".smithers-isolated-clone.json";
const INHERITED_ENV_KEYS = ["HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TEMP", "TMP", "TMPDIR", "USER"];

/** @param {NodeJS.ProcessEnv} ambient @param {Record<string, string | undefined>} [overrides] */
export function isolatedCloneEnvironment(ambient = process.env, overrides = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const key of INHERITED_ENV_KEYS) {
    if (ambient[key] !== undefined) env[key] = ambient[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Spawn a process with streamed stdio. Captured output has no execFileSync
 * maxBuffer ceiling; callers may instead stream stdout directly to a file.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdin?: string, stdoutFile?: string }} [options]
 * @returns {Promise<StreamingProcessResult>}
 */
export function runStreamingProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    /** @type {Buffer[]} */
    const stdout = [];
    /** @type {Buffer[]} */
    const stderr = [];
    const output = options.stdoutFile ? createWriteStream(options.stdoutFile) : null;
    child.stdout.on("data", (chunk) => (output ? output.write(chunk) : stdout.push(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      output?.end();
      const finish = () => {
        const result = {
          code: code ?? 1,
          signal,
          stdout: output ? "" : Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (result.code === 0) resolvePromise(result);
        else reject(new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`));
      };
      if (output && !output.closed) output.once("close", finish);
      else finish();
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  });
}

/** @param {string[]} args @param {Parameters<typeof runStreamingProcess>[2]} [options] @returns {Promise<StreamingProcessResult>} */
function git(args, options = {}) {
  return runStreamingProcess(resolveGitBinary().path, args, options);
}

/** @param {string} repo @returns {Promise<GitRef[]>} */
export async function listGitRefs(repo) {
  const result = await git(["for-each-ref", "--format=%(refname)%00%(objectname)"], { cwd: repo });
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\0");
      return { name: line.slice(0, separator), objectId: line.slice(separator + 1) };
    });
}

/** @param {string} repo @returns {Promise<string[]>} */
export async function gitDirtyPaths(repo) {
  const result = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repo });
  const entries = result.stdout.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes("R") || status.includes("C")) paths.push(entries[++index]);
  }
  return [...new Set(paths)].sort();
}

/** @param {string} file */
async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

/**
 * Create a standalone detached clone at an exact commit. The source working
 * tree, index, refs, bookmarks, and later HEAD movement are deliberately not
 * part of the contract; only `at^{commit}` must be readable while cloning.
 * @param {{ repo: string, at: string, destination?: string }} options
 * @returns {Promise<IsolatedCloneCapsule>}
 */
export async function createIsolatedClone(options) {
  const repo = resolve(options.repo);
  const requestedCommit = options.at;
  const commit = (await git(["rev-parse", "--verify", `${requestedCommit}^{commit}`], { cwd: repo })).stdout.trim();
  const ownedParent = options.destination ? null : await mkdtemp(join(tmpdir(), "smithers-isolated-clone-"));
  const cloneDir = resolve(options.destination ?? join(ownedParent, "repo"));
  if (existsSync(cloneDir)) throw new Error(`isolated clone destination already exists: ${cloneDir}`);
  await mkdir(dirname(cloneDir), { recursive: true });
  await git(["clone", "--no-local", "--no-hardlinks", "--no-checkout", repo, cloneDir]);
  await git(["checkout", "--detach", commit], { cwd: cloneDir });
  await git(["remote", "remove", "origin"], { cwd: cloneDir });
  const refs = await listGitRefs(cloneDir);
  if (refs.length > 0) {
    await git(["update-ref", "--stdin"], {
      cwd: cloneDir,
      stdin: refs.map((ref) => `delete ${ref.name}\n`).join(""),
    });
  }
  const alternates = join(cloneDir, ".git", "objects", "info", "alternates");
  if (existsSync(alternates)) throw new Error(`isolated clone unexpectedly uses alternates: ${alternates}`);
  const nonce = randomUUID();
  const marker = { version: 1, nonce, source: repo, commit, createdAt: new Date().toISOString() };
  const markerPath = join(cloneDir, ".git", MARKER);
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");

  const capsule = {
    path: cloneDir,
    commit,
    marker,
    /** @param {string} command @param {string[]} [args] @param {{ env?: Record<string, string | undefined> }} [runOptions] */
    run(command, args = [], runOptions = {}) {
      return runStreamingProcess(command, args, {
        cwd: cloneDir,
        env: isolatedCloneEnvironment(process.env, runOptions.env),
      });
    },
    /** @param {{ outputDir: string, name?: string }} bundleOptions */
    async emitBundle(bundleOptions) {
      const outputDir = resolve(bundleOptions.outputDir);
      await mkdir(outputDir, { recursive: true });
      const name = bundleOptions.name ?? basename(repo);
      const patchPath = join(outputDir, `${name}.patch`);
      const bundlePath = join(outputDir, `${name}.bundle`);
      const manifestPath = join(outputDir, `${name}.manifest.json`);
      const indexDir = await mkdtemp(join(tmpdir(), "smithers-bundle-index-"));
      const temporaryIndex = join(indexDir, "index");
      const bundleRef = `refs/smithers/bundle-${randomUUID()}`;
      try {
        const indexEnv = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
        await git(["read-tree", "HEAD"], { cwd: cloneDir, env: indexEnv });
        await git(["add", "-A"], { cwd: cloneDir, env: indexEnv });
        await git(["diff", "--cached", "--binary", "--full-index", "HEAD"], {
          cwd: cloneDir,
          env: indexEnv,
          stdoutFile: patchPath,
        });
        await git(["update-ref", bundleRef, "HEAD"], { cwd: cloneDir });
        await git(["bundle", "create", bundlePath, bundleRef], { cwd: cloneDir });
      } finally {
        await git(["update-ref", "-d", bundleRef], { cwd: cloneDir }).catch(() => {});
        await rm(indexDir, { recursive: true, force: true });
      }

      const proofDir = await mkdtemp(join(tmpdir(), "smithers-bundle-proof-"));
      try {
        await git(["init", proofDir]);
        await git(["fetch", bundlePath, `${bundleRef}:refs/heads/imported`], { cwd: proofDir });
        await git(["checkout", "--detach", "refs/heads/imported"], { cwd: proofDir });
        if ((await stat(patchPath)).size > 0) await git(["apply", "--index", patchPath], { cwd: proofDir });
        const imported = (await git(["rev-parse", "HEAD"], { cwd: proofDir })).stdout.trim();
        if (imported !== commit) throw new Error(`fresh bundle import resolved ${imported}, expected ${commit}`);
      } finally {
        await rm(proofDir, { recursive: true, force: true });
      }
      const manifest = {
        version: 1,
        sourceCommit: commit,
        dirtyPaths: await gitDirtyPaths(cloneDir),
        patch: { file: basename(patchPath), sha256: await sha256File(patchPath) },
        bundle: { file: basename(bundlePath), sha256: await sha256File(bundlePath) },
        freshImportVerified: true,
      };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      return { patchPath, bundlePath, manifestPath, manifest };
    },
    async cleanup() {
      const current = JSON.parse(await readFile(markerPath, "utf8"));
      if (current.nonce !== nonce)
        throw new Error(`refusing to clean clone with a foreign ownership marker: ${cloneDir}`);
      await rm(ownedParent ?? cloneDir, { recursive: true, force: true });
    },
  };
  return capsule;
}

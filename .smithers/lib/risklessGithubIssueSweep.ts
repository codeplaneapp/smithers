import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PUBLIC_ISSUE_TOOLCHAIN_BINARIES, resolvePublicIssueToolchainReadPaths } from "./publicIssueAgentPolicy";

export const CANONICAL_REPOSITORY = "smithersai/smithers";
export const MAX_LANES = 16;
export const MAX_REVIEW_BYTES = 512_000;
export const LOG_BYTES = 12_000;

export const PROTECTED_PATHS = [
  ".smithers",
  ".github",
  "scripts",
  "skills",
  "apps/cli",
  "apps/observability",
  "packages/engine",
  "packages/graph",
  "packages/db",
  "packages/gateway",
  "packages/scheduler",
  "packages/driver",
  "packages/vcs",
  "packages/sandbox",
  "packages/memory",
  "packages/scorers",
  "packages/openapi",
] as const;

export const PROTECTED_CONTROL_FILENAMES = [
  ".env",
  ".gitattributes",
  ".gitignore",
  ".gitmodules",
  ".npmrc",
  ".pnpmfile.cjs",
  "AGENTS.md",
  "CLAUDE.md",
  "CODEOWNERS",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "package-lock.json",
  "preload.js",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "turbo.json",
  "yarn.lock",
] as const;
const PROTECTED_CONTROL_FILENAME_SET = new Set<string>(PROTECTED_CONTROL_FILENAMES);
export const PROTECTED_PATH_HINTS = [
  ...PROTECTED_PATHS,
  ...PROTECTED_CONTROL_FILENAMES.map((name) => `**/${name}`),
] as const;

const ALLOWED_SUBJECTS = [
  ["✨", "feat"],
  ["🐛", "fix"],
  ["📝", "docs"],
  ["♻️", "refactor"],
  ["✅", "test"],
  ["🔧", "chore"],
  ["⚡", "perf"],
  ["👷", "ci"],
  ["🏗️", "build"],
  ["⏪", "revert"],
  ["🔒", "fix"],
  ["🙈", "chore"],
] as const;

export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function risklessProofId(domain: string, fields: readonly unknown[]): string {
  if (!isNonBlank(domain)) throw new Error("proof domain must be nonblank");
  return sha256(JSON.stringify(["riskless-proof/v1", domain, ...fields]));
}

export const isNonBlank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export const nonBlankStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isNonBlank);

export function boundedLog(value: string, limit = LOG_BYTES): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= limit) return value;
  return `[display truncated to ${limit} bytes; full machine evidence retained separately]\n${bytes.subarray(bytes.byteLength - limit).toString("utf8")}`;
}

export function explicitPathspec(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

export function protectedPaths(paths: readonly string[]): string[] {
  return explicitPathspec(paths).filter(
    (path) =>
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      PROTECTED_CONTROL_FILENAME_SET.has(path.split("/").at(-1) ?? "") ||
      PROTECTED_PATHS.some((root) => path === root || path.startsWith(`${root}/`)),
  );
}

export function pathsWithinEnvelope(paths: readonly string[], envelope: readonly string[]): boolean {
  const actual = explicitPathspec(paths);
  const admitted = explicitPathspec(envelope);
  return (
    actual.length > 0 &&
    admitted.length > 0 &&
    actual.every((path) =>
      admitted.some((allowed) => {
        if (path === allowed) return true;
        // A directory envelope must be explicit and narrow.  Bare repository or
        // package ancestors ("packages", "packages/foo") never authorize a tree.
        if (!allowed.endsWith("/")) return false;
        const prefix = allowed.replace(/\/+$/, "");
        return prefix.split("/").filter(Boolean).length >= 3 && path.startsWith(`${prefix}/`);
      }),
    )
  );
}

/** Compare repository paths after canonicalizing directory-envelope slashes. */
export function pathsOverlap(left: string, right: string): boolean {
  const normalize = (path: string) => path.replace(/\/+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return a.length > 0 && b.length > 0 && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`));
}

export function canonicalAdmissionEnvelope(paths: readonly string[]): string[] | null {
  if (!nonBlankStrings(paths)) return null;
  const canonical = explicitPathspec(paths);
  if (JSON.stringify(paths) !== JSON.stringify(canonical)) return null;
  if (protectedPaths(canonical).length > 0) return null;
  for (const path of canonical) {
    if (path.startsWith("/") || path.split("/").includes("..")) return null;
    if (path.endsWith("/")) {
      const segments = path.replace(/\/+$/, "").split("/").filter(Boolean);
      if (segments.length < 3) return null;
    }
  }
  return canonical;
}

export function resolveExecutable(pathValue: string, executable: string): string {
  if (!executable || executable.includes("/")) throw new Error(`invalid executable name: ${executable}`);
  for (const directory of pathValue.split(process.platform === "win32" ? ";" : ":").filter(Boolean)) {
    const candidate = join(directory, executable);
    try {
      const resolved = realpathSync(candidate);
      const stat = statSync(resolved);
      if (stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0)) return resolved;
    } catch {
      /* keep searching the sanitized PATH */
    }
  }
  throw new Error(`executable is absent from sanitized PATH: ${executable}`);
}

/**
 * Build a deterministic PATH containing only directories that provide an
 * allowlisted gate executable. macOS sandbox-exec returns EPERM (rather than
 * continuing the search) when execvp encounters an unreadable PATH entry, so
 * passing the operator's full PATH can prevent an otherwise allowed child
 * such as `bun` from launching.
 */
export function sealedToolchainPath(pathValue: string, required: readonly string[] = []): string {
  const directories = pathValue.split(delimiter).filter(Boolean);
  const selected: string[] = [];
  for (const executable of [...PUBLIC_ISSUE_TOOLCHAIN_BINARIES, ...required]) {
    if (!executable || executable.includes("/")) throw new Error(`invalid executable name: ${executable}`);
    const directory = directories.find((candidate) => {
      try {
        const resolved = realpathSync(join(candidate, executable));
        const stat = statSync(resolved);
        return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
      } catch {
        return false;
      }
    });
    if (directory) selected.push(resolve(directory));
  }
  const sealed = [...new Set(selected)];
  if (sealed.length === 0) throw new Error("sanitized PATH contains no allowlisted toolchain executables");
  return sealed.join(delimiter);
}

export function canonicalGithubRemote(remote: string): boolean {
  const normalized = remote.trim().replace(/\.git$/, "");
  return (
    normalized === "git@github.com:smithersai/smithers" ||
    normalized === "https://github.com/smithersai/smithers" ||
    normalized === "ssh://git@github.com/smithersai/smithers"
  );
}

export function exactCommitMessage(message: string, issueNumber: number): boolean {
  const lines = message.trimEnd().split(/\r?\n/);
  const subject = ALLOWED_SUBJECTS.some(([emoji, type]) =>
    new RegExp(
      `^${emoji.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ${type}(?:\\([^\\n()]+\\))?: \\S(?:.*\\S)?$`,
      "u",
    ).test(lines[0] ?? ""),
  );
  const closing = lines.filter((line) => /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[^\n]*#\d+)/i.test(line));
  const authors = lines.filter((line) => /^Co-Authored-By:\s+[^<>]+\s+<[^<>]+>$/i.test(line));
  const issueReferences = message.match(/#\d+|issues\/\d+/gi) ?? [];
  return (
    subject &&
    closing.length === 1 &&
    closing[0] === `Fixes #${issueNumber}` &&
    issueReferences.length === 1 &&
    issueReferences[0]?.toLowerCase() === `#${issueNumber}` &&
    !/[,&#]\s*#\d+/.test(closing[0]) &&
    authors.length >= 1
  );
}

export function focusedCommands(
  root: string,
  paths: readonly string[],
  gateRoot = ".smithers-riskless-gate-output",
): string[][] {
  if (paths.length === 0) throw new Error("an admissible candidate must touch at least one path");
  const commands: string[][] = [];
  let rootScripts: Record<string, unknown> = {};
  try {
    rootScripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  } catch {
    throw new Error("candidate root package.json is missing or invalid");
  }
  const rootCommand = (script: string): string[] => {
    if (typeof rootScripts[script] !== "string" || String(rootScripts[script]).trim().length === 0)
      throw new Error(`candidate root has no deterministic ${script} script`);
    return ["pnpm", script];
  };
  const roots = explicitPathspec(
    paths.map((path) => {
      const match = path.match(/^(packages|apps)\/[^/]+/);
      return match?.[0] ?? "";
    }),
  );
  for (const candidate of roots) {
    // A deleted package root cannot run its former package-local script.  The
    // deterministic root typecheck is its focused deletion check; the global
    // gates below still exercise the complete repository.
    const manifest = join(root, candidate, "package.json");
    if (!existsSync(manifest)) commands.push(rootCommand("typecheck"));
    else {
      let scripts: Record<string, unknown> = {};
      try {
        scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
      } catch {
        throw new Error(`invalid focused package manifest: ${candidate}/package.json`);
      }
      if (typeof scripts.test === "string" && scripts.test.length > 0) commands.push(["pnpm", "-C", candidate, "test"]);
      else if (typeof scripts.typecheck === "string" && scripts.typecheck.length > 0)
        commands.push(["pnpm", "-C", candidate, "typecheck"]);
      else throw new Error(`focused package has no deterministic test/typecheck command: ${candidate}`);
    }
  }
  if (paths.some((p) => p.startsWith("docs/") || p.endsWith(".md") || p.endsWith(".mdx"))) {
    if (!existsSync(join(root, "docs"))) throw new Error("missing focused-test root: docs");
    commands.push(rootCommand("check:docs"), rootCommand("check:llms"));
  }
  const scripts = explicitPathspec(paths.filter((p) => p.startsWith("scripts/")));
  for (const script of scripts) {
    if (!existsSync(join(root, script))) commands.push(rootCommand("typecheck"));
    else if (/(?:^|[./-])test(?:[./-]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(script)) {
      commands.push(["pnpm", "exec", "bun", "test", script]);
    } else if (/\.[cm]?js$/.test(script)) {
      commands.push(["node", "--check", script]);
    } else {
      commands.push([
        "pnpm",
        "exec",
        "bun",
        "build",
        script,
        "--target=bun",
        "--outfile",
        join(gateRoot, `smithers-focused-${sha256(script).slice(0, 12)}.js`),
      ]);
    }
  }
  const rootPaths = paths.filter((p) => !p.includes("/") && !p.endsWith(".md") && !p.endsWith(".mdx"));
  if (rootPaths.length > 0) commands.push(rootCommand("check:deps"));
  const other = paths.filter(
    (p) => !/^(packages|apps|docs|scripts)\//.test(p) && p.includes("/") && !p.endsWith(".md") && !p.endsWith(".mdx"),
  );
  for (const path of other) {
    if (!existsSync(join(root, path))) commands.push(rootCommand("typecheck"));
    else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) commands.push(["pnpm", "exec", "bun", "test", path]);
    else if (/\.[cm]?[jt]sx?$/.test(path))
      commands.push([
        "pnpm",
        "exec",
        "bun",
        "build",
        path,
        "--target=bun",
        "--outfile",
        join(gateRoot, `smithers-focused-${sha256(path).slice(0, 12)}.js`),
      ]);
    else commands.push(rootCommand("check:deps"));
  }
  commands.push(rootCommand("typecheck"), rootCommand("test"));
  return commands.filter(
    (argv, index, all) => index === all.findIndex((x) => JSON.stringify(x) === JSON.stringify(argv)),
  );
}

export type CompleteSnapshot = {
  head: string;
  status: string;
  digest: string;
  paths: string[];
};

type SpawnResult = ReturnType<typeof spawnSync>;
const exitCode = (result: SpawnResult): number =>
  typeof result.status === "number"
    ? result.status
    : result.signal
      ? 128 + ({ SIGKILL: 9, SIGTERM: 15, SIGINT: 2 }[result.signal] ?? 1)
      : 126;

function gitResult(cwd: string, args: string[], input?: string): SpawnResult {
  return spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** A byte-complete candidate snapshot, including untracked and ignored files. */
export function completeCandidateSnapshot(cwd: string): CompleteSnapshot {
  const head = gitResult(cwd, ["rev-parse", "HEAD"]);
  const status = gitResult(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
  const listed = gitResult(cwd, ["ls-files", "-z", "-c", "-o", "--exclude-standard"]);
  const ignored = gitResult(cwd, ["ls-files", "-z", "-o", "-i", "--exclude-standard"]);
  if (exitCode(head) !== 0 || exitCode(status) !== 0 || exitCode(listed) !== 0 || exitCode(ignored) !== 0) {
    throw new Error(
      `candidate snapshot query failed: head=${exitCode(head)} status=${exitCode(status)} files=${exitCode(listed)} ignored=${exitCode(ignored)}`,
    );
  }
  const paths = explicitPathspec(
    [...String(listed.stdout).split("\0"), ...String(ignored.stdout).split("\0")].filter(Boolean),
  );
  const hash = createHash("sha256").update(`HEAD\0${String(head.stdout).trim()}\0STATUS\0${String(status.stdout)}\0`);
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    if (relative(resolve(cwd), absolute).startsWith(`..${sep}`))
      throw new Error(`snapshot path escaped candidate: ${path}`);
    const stat = lstatSync(absolute);
    hash.update(`PATH\0${path}\0MODE\0${stat.mode}\0SIZE\0${stat.size}\0`);
    if (stat.isSymbolicLink()) hash.update(`LINK\0${readlinkSync(absolute)}\0`);
    else if (stat.isFile()) hash.update(readFileSync(absolute));
    else if (!stat.isDirectory()) throw new Error(`unsupported candidate entry: ${path}`);
  }
  return { head: String(head.stdout).trim(), status: String(status.stdout), digest: hash.digest("hex"), paths };
}

export function sanitizedGateEnv(source: NodeJS.ProcessEnv, home: string, pathValue?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: join(home, "tmp"),
    PATH: pathValue ?? source.PATH ?? "/usr/bin:/bin",
    LANG: source.LANG ?? "C.UTF-8",
    LC_ALL: source.LC_ALL ?? source.LANG ?? "C.UTF-8",
    CI: "1",
    OPENSSL_CONF: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_manage_package_manager_versions: "false",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null",
    NO_PROXY: "*",
    no_proxy: "*",
  };
  // Credential/config variables are deliberately allowlisted rather than
  // filtered: GH_TOKEN, GITHUB_TOKEN, GH_HOST, *_TOKEN, *_KEY, npm/git/jj/ssh
  // config, proxy variables, and provider credentials can never cross here.
  return env;
}

function sandboxEscape(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isContained(root: string, path: string): boolean {
  const base = resolve(root);
  const candidate = resolve(path);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

function copyCandidateSource(sourceRoot: string, targetRoot: string): void {
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (source) => {
      const rel = relative(sourceRoot, source);
      return (
        rel !== ".git" &&
        rel !== ".jj" &&
        rel !== "node_modules" &&
        !rel.startsWith(`.git${sep}`) &&
        !rel.startsWith(`.jj${sep}`) &&
        !rel.split(sep).includes("node_modules")
      );
    },
  });
  rmSync(join(targetRoot, ".git"), { recursive: true, force: true });
  rmSync(join(targetRoot, ".jj"), { recursive: true, force: true });
}

function sourceTreeDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      Buffer.from(a.name).compare(Buffer.from(b.name)),
    )) {
      if (entry.name === ".git" || entry.name === ".jj" || entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute);
      const stat = lstatSync(absolute);
      hash.update(`PATH\0${rel}\0MODE\0${stat.mode}\0SIZE\0${stat.size}\0`);
      if (stat.isSymbolicLink()) hash.update(`LINK\0${readlinkSync(absolute)}\0`);
      else if (stat.isFile()) hash.update(readFileSync(absolute));
      else if (stat.isDirectory()) visit(absolute);
      else throw new Error(`unsupported prepared dependency entry: ${rel}`);
    }
  };
  visit(root);
  return hash.digest("hex");
}

function ensureContainedDirectory(root: string, target: string): void {
  const base = realpathSync(root);
  const rel = relative(base, resolve(target));
  if (!rel || rel === "." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    if (resolve(target) === base) return;
    throw new Error(`dependency target escaped disposable root: ${target}`);
  }
  let current = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(`dependency target has a symlink or non-directory ancestor: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current);
    }
  }
  if (realpathSync(target) !== resolve(target) || !isContained(base, target))
    throw new Error(`dependency target parent is not canonically contained: ${target}`);
}

function validateContainedSymlinks(root: string, allowedRoots: readonly string[]): void {
  const allowed = allowedRoots.map((path) => realpathSync(path));
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(absolute);
        if (!allowed.some((candidate) => isContained(candidate, target)))
          throw new Error(`dependency symlink escaped sealed roots: ${absolute} -> ${target}`);
      } else if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
}

function sandboxExecutablePaths(pathValue: string, primary: string): string[] {
  const paths = [primary, "/usr/bin/env", "/bin/sh", "/bin/bash"];
  for (const executable of PUBLIC_ISSUE_TOOLCHAIN_BINARIES) {
    try {
      paths.push(resolveExecutable(pathValue, executable));
    } catch {
      /* A gate only needs binaries that exist in its sanitized PATH. */
    }
  }
  return explicitPathspec(
    paths.flatMap((path) => {
      try {
        return [resolve(path), realpathSync(path)];
      } catch {
        return [];
      }
    }),
  );
}

function sandboxProfile(
  writeRoot: string,
  readRootsInput: readonly string[],
  execPathsInput: readonly string[],
  execRootsInput: readonly string[],
  hostHome: string,
): string {
  const credentialPaths = hostHome
    ? [
        ".ssh",
        ".aws",
        ".azure",
        ".config",
        ".kube",
        ".docker",
        ".gitconfig",
        ".git-credentials",
        ".npmrc",
        ".netrc",
        ".claude",
        ".codex",
        ".smithers",
        "Library/Keychains",
      ]
        .map((entry) => `(subpath "${sandboxEscape(join(hostHome, entry))}")`)
        .join(" ")
    : "";
  const readRoots = explicitPathspec(readRootsInput.map((path) => resolve(path)));
  const execPaths = explicitPathspec(execPathsInput.map((path) => resolve(path)));
  const execRoots = explicitPathspec(execRootsInput.map((path) => realpathSync(path)));
  const traversal = new Set<string>(["/"]);
  for (const root of readRoots) {
    let parent = dirname(root);
    while (parent !== "." && !traversal.has(parent)) {
      traversal.add(parent);
      if (parent === "/") break;
      parent = dirname(parent);
    }
  }
  const readRules = [
    ...[...traversal].sort().map((path) => `(literal "${sandboxEscape(path)}")`),
    ...readRoots.map((path) => `(subpath "${sandboxEscape(path)}")`),
  ].join(" ");
  const execRules = [
    ...execPaths.map((path) => `(literal "${sandboxEscape(path)}")`),
    ...execRoots.map((path) => `(subpath "${sandboxEscape(path)}")`),
  ].join(" ");
  const sysctlRules = `(sysctl-name-prefix "hw.") ${["kern.hostname", "kern.osrelease", "kern.ostype", "kern.version"].map((name) => `(sysctl-name "${name}")`).join(" ")}`;
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec ${execRules})`,
    "(allow process-fork)",
    `(allow sysctl-read ${sysctlRules})`,
    "(allow ipc-posix-shm)",
    "(allow signal (target self))",
    credentialPaths
      ? `(deny file-read* ${credentialPaths} (regex #"/\\.env(?:\\..*)?$"))`
      : `(deny file-read* (regex #"/\\.env(?:\\..*)?$"))`,
    `(allow file-read* ${readRules})`,
    `(allow file-write* (subpath "${sandboxEscape(realpathSync(writeRoot))}"))`,
    "(deny network*)",
  ].join("\n");
}

export function resolvePnpmStore(pathValue = process.env.PATH ?? "/usr/bin:/bin", explicitStore?: string): string {
  let candidate = explicitStore ?? "";
  if (!candidate) {
    const executable = resolveExecutable(pathValue, "pnpm");
    const result = spawnSync(executable, ["store", "path", "--silent"], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: pathValue,
        HOME: homedir(),
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? "C.UTF-8",
        npm_config_manage_package_manager_versions: "false",
        NPM_CONFIG_USERCONFIG: "/dev/null",
        NPM_CONFIG_GLOBALCONFIG: "/dev/null",
      },
    });
    if (exitCode(result) !== 0) throw new Error(`pnpm store query failed: ${exitCode(result)}`);
    candidate = String(result.stdout).trim();
  }
  if (!isAbsolute(candidate) || !existsSync(candidate)) throw new Error("pnpm store is absent or not absolute");
  const store = realpathSync(candidate);
  if (!statSync(store).isDirectory()) throw new Error("pnpm store is not a directory");
  const home = realpathSync(homedir());
  if (store === home || isContained(store, home)) throw new Error("pnpm store may not contain the operator home");
  for (const entry of [
    ".ssh",
    ".aws",
    ".azure",
    ".config",
    ".kube",
    ".docker",
    ".claude",
    ".codex",
    ".gitconfig",
    ".git-credentials",
    ".npmrc",
    ".netrc",
    "Library/Keychains",
  ]) {
    const credential = join(home, entry);
    if (store === credential || isContained(store, credential))
      throw new Error("pnpm store may not contain a credential path");
  }
  return store;
}

type DependencyInstallEvidence = {
  argv: string[];
  exitCode: number;
  signal: string;
  launchError: string;
  stdout: string;
  stderr: string;
};

export type IsolatedGateDependencyBinding = {
  parent: string;
  root: string;
  candidate: CompleteSnapshot;
  sourceDigest: string;
  lockfileSha256: string;
  bindingId: string;
  install: DependencyInstallEvidence;
  disposed: boolean;
};

export function prepareIsolatedGateDependencies(
  cwd: string,
  options: { path?: string; storeDir?: string; timeoutMs?: number } = {},
): IsolatedGateDependencyBinding {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    throw new Error("macOS sandbox-exec is required for riskless dependency materialization");
  const candidate = completeCandidateSnapshot(cwd);
  const lockfile = join(cwd, "pnpm-lock.yaml");
  const lockStat = lstatSync(lockfile);
  if (!lockStat.isFile() || lockStat.isSymbolicLink())
    throw new Error("candidate pnpm-lock.yaml must be a regular file");
  const lockfileSha256 = sha256(readFileSync(lockfile));
  const parent = mkdtempSync(join(tmpdir(), "smithers-riskless-deps-"));
  const parentReal = realpathSync(parent);
  const copy = join(parentReal, "repo");
  const home = join(parentReal, "home");
  mkdirSync(join(home, "tmp"), { recursive: true });
  try {
    copyCandidateSource(realpathSync(cwd), copy);
    const sourceDigest = sourceTreeDigest(copy);
    const copiedLock = join(copy, "pnpm-lock.yaml");
    if (sha256(readFileSync(copiedLock)) !== lockfileSha256)
      throw new Error("candidate lockfile changed during dependency copy");
    const sourcePathValue = options.path ?? process.env.PATH ?? "/usr/bin:/bin";
    const pathValue = sealedToolchainPath(sourcePathValue, ["pnpm"]);
    const pnpm = resolveExecutable(pathValue, "pnpm");
    const store = resolvePnpmStore(pathValue, options.storeDir);
    const argv = [
      "pnpm",
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--verify-store-integrity",
      "--package-import-method=clone",
      "--store-dir",
      store,
    ];
    const toolchainReads = resolvePublicIssueToolchainReadPaths({ ...process.env, PATH: pathValue });
    const profile = sandboxProfile(
      parentReal,
      [
        parentReal,
        pnpm,
        dirname(pnpm),
        ...toolchainReads,
        store,
        "/System",
        "/System/Cryptexes",
        "/usr",
        "/bin",
        "/sbin",
        "/Library/Apple",
        "/Library/Frameworks",
        "/private/etc",
        "/etc",
        "/private/var/db",
        "/private/var/select/sh",
        "/var/db",
        "/dev",
      ],
      sandboxExecutablePaths(pathValue, pnpm),
      [parentReal],
      homedir(),
    );
    const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "--", pnpm, ...argv.slice(1)], {
      cwd: copy,
      env: sanitizedGateEnv(process.env, home, pathValue),
      encoding: "utf8",
      timeout: options.timeoutMs ?? 30 * 60_000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const install = {
      argv,
      exitCode: exitCode(result),
      signal: result.signal ?? "",
      launchError: result.error?.message ?? "",
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
    if (install.exitCode !== 0 || install.signal || install.launchError)
      throw new Error(
        `offline frozen dependency install failed: exit=${install.exitCode} signal=${install.signal} ${install.launchError} ${boundedLog(install.stderr)}`,
      );
    if (sourceTreeDigest(copy) !== sourceDigest || sha256(readFileSync(copiedLock)) !== lockfileSha256)
      throw new Error("dependency materialization changed candidate source or lockfile");
    const virtualStore = join(copy, "node_modules", ".pnpm");
    if (!existsSync(virtualStore) || !lstatSync(virtualStore).isDirectory())
      throw new Error("offline install produced no sealed virtual store");
    validateContainedSymlinks(join(copy, "node_modules"), [copy]);
    const bindingId = sha256(
      JSON.stringify(["riskless-gate-dependencies/v1", candidate.head, candidate.digest, lockfileSha256, sourceDigest]),
    );
    return {
      parent: parentReal,
      root: copy,
      candidate,
      sourceDigest,
      lockfileSha256,
      bindingId,
      install,
      disposed: false,
    };
  } catch (error) {
    rmSync(parentReal, { recursive: true, force: true });
    throw error;
  }
}

export function disposeIsolatedGateDependencies(binding: IsolatedGateDependencyBinding): boolean {
  if (!binding.disposed) {
    rmSync(binding.parent, { recursive: true, force: true });
    binding.disposed = !existsSync(binding.parent);
  }
  return binding.disposed;
}

function linkPreparedDependencies(binding: IsolatedGateDependencyBinding, copy: string): void {
  if (binding.disposed || !existsSync(binding.root)) throw new Error("sealed dependency binding is unavailable");
  const workspaceRoots = ["", ".smithers", "e2e", "codex-plugin"];
  for (const parentName of ["packages", "apps"]) {
    const parent = join(binding.root, parentName);
    if (existsSync(parent))
      for (const entry of readdirSync(parent, { withFileTypes: true }))
        if (entry.isDirectory()) workspaceRoots.push(join(parentName, entry.name));
  }
  const preparedVirtualStore = realpathSync(join(binding.root, "node_modules", ".pnpm"));
  for (const workspace of workspaceRoots) {
    const source = join(binding.root, workspace, "node_modules");
    if (!existsSync(source)) continue;
    const target = join(copy, workspace, "node_modules");
    ensureContainedDirectory(copy, dirname(target));
    cpSync(source, target, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (sourcePath) => {
        const rel = relative(source, sourcePath);
        return workspace !== "" || (rel !== ".pnpm" && !rel.startsWith(`.pnpm${sep}`));
      },
    });
  }
  const targetVirtualStore = join(copy, "node_modules", ".pnpm");
  try {
    lstatSync(targetVirtualStore);
    throw new Error("fresh gate copy unexpectedly contains a virtual store");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  ensureContainedDirectory(copy, dirname(targetVirtualStore));
  symlinkSync(preparedVirtualStore, targetVirtualStore, "dir");
  validateContainedSymlinks(join(copy, "node_modules"), [copy, preparedVirtualStore]);
}

export type IsolatedGateResult = {
  argv: string[];
  exitCode: number;
  passed: boolean;
  timedOut: boolean;
  signal: string;
  launchError: string;
  stdout: string;
  stderr: string;
  before: CompleteSnapshot;
  after: CompleteSnapshot;
  unchanged: boolean;
  disposableRemoved: boolean;
  dependencyBindingId: string;
  dependencyHead: string;
  dependencyDigest: string;
  lockfileSha256: string;
  dependencyInstallArgv: string[];
  dependencyInstallExitCode: number;
  dependencyInstallSignal: string;
  dependencyInstallError: string;
  dependencyInstallLog: string;
  dependencyBindingRemoved: boolean;
};

/**
 * Run one gate in a throw-away filesystem copy. On macOS this is an actual
 * sandbox-exec process with no network, an allowlisted toolchain, and HOME/TMP
 * inside the disposable tree. Any copy/query/launch/cleanup error fails closed.
 */
export function runIsolatedGate(
  cwd: string,
  argv: readonly string[],
  options: { timeoutMs?: number; path?: string; storeDir?: string; binding?: IsolatedGateDependencyBinding } = {},
): IsolatedGateResult {
  if (argv.length === 0) throw new Error("empty gate command");
  const before = completeCandidateSnapshot(cwd);
  const ownBinding = !options.binding;
  const binding =
    options.binding ??
    prepareIsolatedGateDependencies(cwd, {
      path: options.path,
      storeDir: options.storeDir,
      timeoutMs: options.timeoutMs,
    });
  if (
    binding.disposed ||
    binding.candidate.head !== before.head ||
    binding.candidate.status !== before.status ||
    binding.candidate.digest !== before.digest
  )
    throw new Error("sealed dependencies do not match the exact candidate snapshot");
  const parent = mkdtempSync(join(tmpdir(), "smithers-riskless-gate-"));
  const parentReal = realpathSync(parent);
  const copy = join(parentReal, "repo");
  const home = join(parentReal, "home");
  mkdirSync(join(home, "tmp"), { recursive: true });
  let child: SpawnResult | undefined;
  let launchError = "";
  let disposableRemoved = false;
  let dependencyBindingRemoved = false;
  try {
    copyCandidateSource(realpathSync(cwd), copy);
    if (sourceTreeDigest(copy) !== binding.sourceDigest)
      throw new Error("fresh gate copy differs from the dependency-bound candidate source");
    linkPreparedDependencies(binding, copy);
    mkdirSync(join(copy, ".smithers-riskless-gate-output"), { recursive: true });
    const sourcePathValue = options.path ?? process.env.PATH ?? "/usr/bin:/bin";
    const pathValue = sealedToolchainPath(sourcePathValue, [argv[0]!]);
    const executable = resolveExecutable(pathValue, argv[0]!);
    const env = sanitizedGateEnv(process.env, home, pathValue);
    const toolchainReads = resolvePublicIssueToolchainReadPaths({ ...process.env, PATH: pathValue });
    const preparedVirtualStore = realpathSync(join(binding.root, "node_modules", ".pnpm"));
    const profile = sandboxProfile(
      parentReal,
      [
        parentReal,
        preparedVirtualStore,
        executable,
        dirname(executable),
        ...toolchainReads,
        "/System",
        "/System/Cryptexes",
        "/usr",
        "/bin",
        "/sbin",
        "/Library/Apple",
        "/Library/Frameworks",
        "/private/etc",
        "/etc",
        "/private/var/db",
        "/private/var/select/sh",
        "/var/db",
        "/dev",
      ],
      sandboxExecutablePaths(pathValue, executable),
      [parentReal, preparedVirtualStore],
      homedir(),
    );
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
      launchError = "macOS sandbox-exec is required for riskless gates";
    } else {
      child = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "--", executable, ...argv.slice(1)], {
        cwd: copy,
        env,
        encoding: "utf8",
        timeout: options.timeoutMs ?? 30 * 60_000,
        maxBuffer: 256 * 1024 * 1024,
      });
      if (child.error) launchError = child.error.message;
    }
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      rmSync(parent, { recursive: true, force: true });
      disposableRemoved = !existsSync(parent);
    } catch (error) {
      launchError += `${launchError ? "; " : ""}cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (ownBinding) {
      try {
        dependencyBindingRemoved = disposeIsolatedGateDependencies(binding);
      } catch (error) {
        launchError += `${launchError ? "; " : ""}dependency cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  const after = completeCandidateSnapshot(cwd);
  const unchanged = before.head === after.head && before.status === after.status && before.digest === after.digest;
  const code = child ? exitCode(child) : 126;
  const signal = child?.signal ?? "";
  const timedOut =
    Boolean(child?.error && (child.error as NodeJS.ErrnoException).code === "ETIMEDOUT") || signal === "SIGTERM";
  const passed =
    code === 0 &&
    !signal &&
    !launchError &&
    unchanged &&
    disposableRemoved &&
    (!ownBinding || dependencyBindingRemoved);
  return {
    argv: [...argv],
    exitCode: code,
    passed,
    timedOut,
    signal,
    launchError,
    stdout: String(child?.stdout ?? ""),
    stderr: String(child?.stderr ?? ""),
    before,
    after,
    unchanged,
    disposableRemoved,
    dependencyBindingId: binding.bindingId,
    dependencyHead: binding.candidate.head,
    dependencyDigest: binding.candidate.digest,
    lockfileSha256: binding.lockfileSha256,
    dependencyInstallArgv: binding.install.argv,
    dependencyInstallExitCode: binding.install.exitCode,
    dependencyInstallSignal: binding.install.signal,
    dependencyInstallError: binding.install.launchError,
    dependencyInstallLog: boundedLog(
      `${binding.install.stdout}\n${binding.install.stderr}\n${binding.install.launchError}`,
    ),
    dependencyBindingRemoved,
  };
}

export function peerPathOverlaps(
  issueNumber: number,
  paths: readonly string[],
  peers: readonly { issueNumber: number; changedPaths: readonly string[]; identicalAlreadyLanded?: boolean }[],
): number[] {
  return peers
    .filter(
      (peer) =>
        peer.issueNumber !== issueNumber &&
        !peer.identicalAlreadyLanded &&
        paths.some((left) => peer.changedPaths.some((right) => pathsOverlap(left, right))),
    )
    .map((peer) => peer.issueNumber)
    .sort((a, b) => a - b);
}

export function exactLandingProvenance(
  expected: {
    issueNumber: number;
    headSha: string;
    diffSha256: string;
    patchId: string;
    changedPaths: readonly string[];
    iteration: number;
  },
  actual: typeof expected,
): boolean {
  return (
    expected.issueNumber === actual.issueNumber &&
    expected.headSha === actual.headSha &&
    expected.diffSha256 === actual.diffSha256 &&
    expected.patchId === actual.patchId &&
    expected.iteration === actual.iteration &&
    JSON.stringify(expected.changedPaths) === JSON.stringify(actual.changedPaths)
  );
}

export type ExactCommitTuple = {
  issueNumber: number;
  parentSha: string;
  headSha: string;
  diffSha256: string;
  patchId: string;
  changedPaths: string[];
  commitMessageSha256: string;
};

/** Inspect one commit without fallbacks; every failed Git query is evidence failure. */
export function exactCommitTuple(cwd: string, issueNumber: number, sha: string): ExactCommitTuple {
  if (!/^\p{ASCII_Hex_Digit}{40,64}$/v.test(sha)) throw new Error("invalid commit sha");
  const type = gitResult(cwd, ["cat-file", "-t", sha]);
  const parents = gitResult(cwd, ["rev-list", "--parents", "-n", "1", sha]);
  const message = gitResult(cwd, ["show", "-s", "--format=%B", sha]);
  const names = gitResult(cwd, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha]);
  if ([type, parents, message, names].some((result) => exitCode(result) !== 0))
    throw new Error("exact commit evidence query failed");
  const parentFields = String(parents.stdout).trim().split(/\s+/);
  if (String(type.stdout).trim() !== "commit" || parentFields.length !== 2)
    throw new Error("recovery target must be one non-merge commit");
  const parentSha = parentFields[1]!;
  const patch = gitResult(cwd, ["diff", "--binary", "--full-index", "--no-ext-diff", parentSha, sha, "--"]);
  if (exitCode(patch) !== 0) throw new Error("exact commit patch query failed");
  if (!exactCommitMessage(String(message.stdout), issueNumber))
    throw new Error("commit message is not exact target-only closure");
  const stable = gitResult(cwd, ["patch-id", "--stable"], String(patch.stdout));
  if (exitCode(stable) !== 0) throw new Error("stable patch-id query failed");
  const patchId = String(stable.stdout).trim().split(/\s+/)[0] ?? "";
  const changedPaths = explicitPathspec(String(names.stdout).split("\0").filter(Boolean));
  if (!isNonBlank(patchId) || changedPaths.length === 0) throw new Error("commit has no exact nonempty patch evidence");
  return {
    issueNumber,
    parentSha,
    headSha: sha,
    diffSha256: sha256(String(patch.stdout)),
    patchId,
    changedPaths,
    commitMessageSha256: sha256(String(message.stdout).trimEnd()),
  };
}

export function authorizeClosureRecovery(
  cwd: string,
  expected: Pick<ExactCommitTuple, "issueNumber" | "headSha" | "diffSha256" | "patchId" | "changedPaths">,
  envelope: readonly string[],
): ExactCommitTuple {
  const actual = exactCommitTuple(cwd, expected.issueNumber, expected.headSha);
  const exact =
    expected.issueNumber === actual.issueNumber &&
    expected.headSha === actual.headSha &&
    expected.diffSha256 === actual.diffSha256 &&
    expected.patchId === actual.patchId &&
    JSON.stringify(expected.changedPaths) === JSON.stringify(actual.changedPaths);
  if (!exact || !pathsWithinEnvelope(actual.changedPaths, envelope))
    throw new Error("recovery tuple or narrow path envelope mismatch");
  return actual;
}

export function commitPatchId(cwd: string, sha: string): string {
  const shown = gitResult(cwd, ["show", "--pretty=format:", "--binary", "--full-index", "--no-ext-diff", sha]);
  if (exitCode(shown) !== 0) throw new Error(`git show failed for patch equivalence: ${exitCode(shown)}`);
  const stable = gitResult(cwd, ["patch-id", "--stable"], String(shown.stdout));
  if (exitCode(stable) !== 0) throw new Error(`git patch-id failed: ${exitCode(stable)}`);
  const id = String(stable.stdout).trim().split(/\s+/)[0] ?? "";
  if (!id) throw new Error("git patch-id returned no complete id");
  return id;
}

export function publicationBoundaryAuthorized(input: {
  issueState: "open" | "closed" | "missing";
  collisionQueryOk: boolean;
  collisions: readonly string[];
  provenanceMatches: boolean;
  canonicalRemote: boolean;
  proposalValid: boolean;
  proposalDecision: "propose" | "defer";
  stagePaths: readonly string[];
}): boolean {
  return (
    input.issueState === "open" &&
    input.collisionQueryOk &&
    input.collisions.length === 0 &&
    input.provenanceMatches &&
    input.canonicalRemote &&
    input.proposalValid &&
    input.proposalDecision === "propose" &&
    input.stagePaths.length === 0
  );
}

export function dryRunMainIsCurrent(remote: string, localMain: string, trackingMain: string, head: string): boolean {
  return remote.length > 0 && remote === localMain && remote === trackingMain && remote === head;
}

export function fixpointDecision(input: {
  discoveredCount: number;
  exclusions: readonly number[];
  missingEvidence: readonly string[];
  newOrEdited: readonly number[];
  landedCount: number;
  remainingOpen: readonly number[];
  remainingIndependentlyNotRiskless: boolean;
}): { completed: boolean; fixpoint: boolean } {
  const completeEvidence =
    input.discoveredCount > 0 &&
    input.exclusions.length === 0 &&
    input.missingEvidence.length === 0 &&
    input.newOrEdited.length === 0;
  const changedBaseWithRemaining = input.landedCount > 0 && input.remainingOpen.length > 0;
  const fixpoint = completeEvidence && !changedBaseWithRemaining && input.remainingIndependentlyNotRiskless;
  return { completed: fixpoint, fixpoint };
}

export function stableOperationMarker(repo: string, issue: number, sha: string): string {
  return `<!-- smithers:riskless-sweep:${sha256(`${repo}:${issue}:${sha}`).slice(0, 24)} -->`;
}

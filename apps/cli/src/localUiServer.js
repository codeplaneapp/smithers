import { createServer } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * The full local Smithers UI — `apps/smithers`. The CLI builds it (if a source
 * tree is present and the bundle is stale) and serves the bundle from a small
 * static server that reverse-proxies the gateway's RPC/WS/health paths so the
 * app runs same-origin with the gateway (its WebSocket needs same-origin).
 *
 * Resolution order for the app:
 *   1. The in-repo source at `apps/smithers`, when it is present and buildable
 *      — built on demand with its own vite
 *      (`apps/smithers/node_modules/.bin/vite build`). A source checkout must
 *      serve the code under edit: `ui-dist` is a pack-time artifact (gitignored,
 *      staged by `prepack`) and is treated as permanently fresh below, so
 *      preferring it here would silently serve a bundle from whenever the tree
 *      was last packed.
 *   2. A prebuilt bundle shipped beside the CLI (`apps/cli/ui-dist`) — the
 *      published path; no build step, works offline. Also the fallback for a
 *      slimmed checkout where the source app has no vite installed.
 */
export function chooseLocalUiSource({ hasBundle, hasSource, hasVite }) {
  if (hasSource && (hasVite || !hasBundle)) return "source";
  if (hasBundle) return "bundle";
  return null;
}

export function resolveLocalUi() {
  const bundledDist = resolve(moduleDir, "..", "ui-dist");
  // apps/cli/src -> apps/cli -> apps -> apps/smithers
  const appDir = resolve(moduleDir, "..", "..", "smithers");
  const viteBin = resolve(appDir, "node_modules", ".bin", "vite");
  const choice = chooseLocalUiSource({
    hasBundle: existsSync(join(bundledDist, "index.html")),
    hasSource: existsSync(join(appDir, "package.json")),
    hasVite: existsSync(viteBin),
  });
  if (choice === "source") return { distDir: resolve(appDir, "dist"), appDir, viteBin };
  if (choice === "bundle") return { distDir: bundledDist, appDir: null, viteBin: null };
  return null;
}

/** Is the built bundle present and newer than the newest source file? */
export function bundleIsFresh(distDir, appDir) {
  const indexHtml = join(distDir, "index.html");
  if (!existsSync(indexHtml)) return false;
  if (!appDir) return true; // prebuilt bundle: always fresh
  const builtAt = statSync(indexHtml).mtimeMs;
  let newest = 0;
  const walk = (dir) => {
    for (const name of safeReaddir(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
      } else if (st.mtimeMs > newest) {
        newest = st.mtimeMs;
      }
    }
  };
  walk(join(appDir, "src"));
  try {
    const appPackage = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
    const requireFromApp = createRequire(join(appDir, "package.json"));
    const visited = new Set();
    const visitWorkspaceDependency = (dependencyDir) => {
      let canonicalDir;
      try {
        canonicalDir = realpathSync(dependencyDir);
      } catch {
        canonicalDir = dependencyDir;
      }
      if (visited.has(canonicalDir)) return;
      visited.add(canonicalDir);
      const manifestPath = join(canonicalDir, "package.json");
      if (!existsSync(manifestPath)) return;
      const manifestStat = statSync(manifestPath);
      if (manifestStat.mtimeMs > newest) newest = manifestStat.mtimeMs;
      walk(join(canonicalDir, "src"));
      let dependencyPackage;
      try {
        dependencyPackage = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        return;
      }
      const requireFromDependency = createRequire(manifestPath);
      for (const name of Object.keys(dependencyPackage.dependencies ?? {})) {
        if (!name.startsWith("@smithers-orchestrator/")) continue;
        const transitiveDir =
          resolveDependencyDir(requireFromDependency, canonicalDir, name) ??
          resolveDependencyDir(requireFromApp, appDir, name);
        if (transitiveDir) visitWorkspaceDependency(transitiveDir);
      }
    };
    for (const name of Object.keys(appPackage.dependencies ?? {})) {
      if (!name.startsWith("@smithers-orchestrator/")) continue;
      const dependencyDir = resolveDependencyDir(requireFromApp, appDir, name);
      if (dependencyDir) visitWorkspaceDependency(dependencyDir);
    }
  } catch {
    // A missing or malformed package manifest is handled by the build itself.
  }
  // Also consider config files.
  for (const f of ["vite.config.ts", "index.html", "package.json"]) {
    const p = join(appDir, f);
    if (existsSync(p)) {
      const m = statSync(p).mtimeMs;
      if (m > newest) newest = m;
    }
  }
  return builtAt >= newest;
}

/**
 * Where does `name` actually live on disk, as seen from the app? Vite inlines
 * workspace packages from their `src/`, so freshness has to see those sources.
 * Entry resolution can fail (export conditions the CommonJS resolver can't
 * take), so fall back to the app's own `node_modules` link; unresolvable
 * dependencies are simply skipped — the build itself reports those.
 */
function resolveDependencyDir(requireFromApp, appDir, name) {
  try {
    let dir = dirname(requireFromApp.resolve(name));
    while (dirname(dir) !== dir) {
      const packageJson = join(dir, "package.json");
      if (existsSync(packageJson)) {
        const dependencyPackage = JSON.parse(readFileSync(packageJson, "utf8"));
        if (dependencyPackage.name === name) return dir;
      }
      dir = dirname(dir);
    }
  } catch {
    // Fall through to the node_modules layout below.
  }
  const linked = join(appDir, "node_modules", ...name.split("/"));
  try {
    if (existsSync(join(linked, "package.json"))) return realpathSync(linked);
  } catch {
    // Not installed here.
  }
  return null;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The concierge chat backend needs exactly one upstream chat credential. Mirror
 * the check in apps/smithers/concierge/server.ts so `smithers ui --app` can fail
 * fast with a readable message instead of starting an app whose chat returns 500.
 */
export function hasConciergeCredential(env) {
  return Boolean(
    env.CEREBRAS_API_KEY?.trim() ||
    env.CODEX_ACCESS_TOKEN?.trim() ||
    env.CODEX_REFRESH_TOKEN?.trim() ||
    env.OPENAI_API_KEY?.trim(),
  );
}

const MISSING_CREDENTIAL_MESSAGE = [
  "The local Smithers UI needs a chat credential for its concierge, and none is set.",
  "",
  "Set ONE of these before running `smithers ui --app`:",
  "  • CEREBRAS_API_KEY   — https://cloud.cerebras.ai (fast, recommended)",
  "  • OPENAI_API_KEY     — https://platform.openai.com/api-keys",
  "  • CODEX_ACCESS_TOKEN / CODEX_REFRESH_TOKEN — your Codex/ChatGPT subscription token",
  "",
  "Example:  CEREBRAS_API_KEY=csk-... smithers ui --app",
].join("\n");

/** The concierge is a Bun.serve process, so `bun` must be on PATH to run it. */
export function hasBunOnPath() {
  try {
    return spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const MISSING_BUN_MESSAGE = [
  "The local Smithers UI chat backend runs on Bun, and `bun` is not on your PATH.",
  "",
  "Install it, then rerun `smithers ui --app`:",
  "  curl -fsSL https://bun.sh/install | bash",
].join("\n");

/** Build the bundle with the app's own vite. Returns true on success. */
function buildBundle(appDir, viteBin) {
  if (!viteBin || !existsSync(viteBin)) {
    process.stderr.write(
      `[smithers] Cannot build the UI: vite is not installed in ${appDir}. Run \`pnpm install\` in the repo, then \`pnpm -C apps/cli build:ui\` to stage a prebuilt bundle at apps/cli/ui-dist.\n`,
    );
    return false;
  }
  process.stderr.write("[smithers] Building the local UI (vite build)…\n");
  const result = spawnSync(viteBin, ["build"], {
    cwd: appDir,
    stdio: "inherit",
  });
  return result.status === 0;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

// Paths proxied to the gateway. Everything else is served from the bundle.
const GATEWAY_PREFIXES = ["/v1/rpc", "/v1/", "/health", "/workflows"];
const LOCAL_VCS_PATH = "/__smithers/vcs";
const LOCAL_WORKSPACE_PREFIX = "/__smithers/local-workspace";
const FILES_API_PREFIX = "/api/files";
const FILE_PREVIEW_BYTES = 128 * 1024;
const FILE_EDIT_BYTES = 512 * 1024;
const FILE_TREE_LIMIT = 1_000;

function isGatewayPath(pathname) {
  return GATEWAY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

function parentDir(path) {
  const parent = dirname(path);
  return parent === path ? null : parent;
}

function detectLocalRepo(startPath) {
  const workspacePath = resolve(startPath);
  let cursor = workspacePath;
  let gitRoot = null;
  let jjRoot = null;
  while (cursor) {
    if (!jjRoot && existsSync(join(cursor, ".jj"))) jjRoot = cursor;
    if (!gitRoot && existsSync(join(cursor, ".git"))) gitRoot = cursor;
    if (gitRoot && jjRoot) break;
    cursor = parentDir(cursor);
  }
  return {
    workspacePath,
    repoRoot: jjRoot ?? gitRoot,
    primary: jjRoot ? "jj" : gitRoot ? "git" : null,
    hasGit: gitRoot !== null,
    hasJj: jjRoot !== null,
  };
}

function runLocal(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited ${result.status}`).trim());
  }
  return result.stdout || "";
}

function gitCategory(code) {
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  if (code === "??") return "untracked";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("M") || code.includes("T")) return "modified";
  return "unknown";
}

function parseGitStatus(output) {
  const changes = [];
  let current = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith("## ")) {
      const branch = line.slice(3);
      const noCommits = branch.match(/^No commits yet on (.+)$/);
      current = noCommits
        ? noCommits[1]
        : branch.startsWith("HEAD ")
          ? "detached"
          : branch.split("...")[0].split(" [")[0].trim();
      continue;
    }
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    const rename = rest.match(/^(.*) -> (.*)$/);
    changes.push({
      status,
      category: gitCategory(status),
      path: rename ? rename[2] : rest,
      ...(rename ? { oldPath: rename[1] } : {}),
    });
  }
  return { current, changes, clean: changes.length === 0 };
}

function parseBranches(output) {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.replace(/^\*\s*/, "").trim())
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function unquoteJjPath(path) {
  const trimmed = path.trim();
  const quoted = trimmed.match(/^"(.+)"$/);
  return quoted ? quoted[1] : trimmed;
}

function jjPath(line) {
  const withoutKind = line
    .replace(/^(Added|Modified|Deleted|Renamed|Copied|Untracked|Conflicted?|Conflict)\s+/i, "")
    .replace(/^regular file\s+/i, "")
    .replace(/^file\s+/i, "")
    .trim();
  return unquoteJjPath(withoutKind);
}

function jjCategory(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "a") return "added";
  if (normalized === "m") return "modified";
  if (normalized === "d") return "deleted";
  if (normalized === "r") return "renamed";
  if (normalized === "c") return "conflicted";
  if (normalized === "?") return "untracked";
  if (normalized.startsWith("added ")) return "added";
  if (normalized.startsWith("modified ")) return "modified";
  if (normalized.startsWith("deleted ")) return "deleted";
  if (normalized.startsWith("renamed ")) return "renamed";
  if (normalized.startsWith("copied ")) return "copied";
  if (normalized.startsWith("conflict")) return "conflicted";
  if (normalized.startsWith("untracked ")) return "untracked";
  return "unknown";
}

function parseCompactJjChange(line) {
  const match = line.match(/^([MADRC?])\s+(.+)$/);
  if (!match) return null;
  const status = match[1];
  const rest = match[2].trim();
  const rename = rest.match(/^(.*?)\s+(?:=>|->)\s+(.*)$/);
  return {
    status,
    category: jjCategory(status),
    path: unquoteJjPath(rename ? rename[2] : rest),
    ...(rename ? { oldPath: unquoteJjPath(rename[1]) } : {}),
  };
}

function parseJjStatus(output) {
  const changes = [];
  let current = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const workingCopy = line.match(/^Working copy(?:\s+\(([^)]+)\))?\s*:\s*([^\s]+)?/i);
    if (workingCopy) {
      current = workingCopy[1] || workingCopy[2] || null;
      continue;
    }
    const compactChange = parseCompactJjChange(line);
    if (compactChange) {
      changes.push(compactChange);
      continue;
    }
    if (/^(Added|Modified|Deleted|Renamed|Copied|Untracked|Conflicted?|Conflict)\s+/i.test(line)) {
      changes.push({
        status: line.split(/\s+/)[0] || "Unknown",
        category: jjCategory(line),
        path: jjPath(line),
      });
    }
  }
  return { current, changes, clean: changes.length === 0 };
}

function parseJjBookmarks(output) {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .filter((line) => line.trim() === line)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith("Hint:"))
        .map((line) =>
          line
            .replace(/\s+\((?:conflicted|deleted)\):?.*$/i, "")
            .split(":")[0]
            .replace(/\*$/, "")
            .trim(),
        )
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function unavailable(kind, error) {
  return {
    kind,
    available: false,
    repoRoot: null,
    current: null,
    bookmarks: [],
    changes: [],
    clean: false,
    error: error?.message ?? String(error),
  };
}

function readLocalVcsSnapshot(workspacePath) {
  const detection = detectLocalRepo(workspacePath);
  const snapshot = {
    workspacePath: detection.workspacePath,
    repoRoot: detection.repoRoot,
    primary: detection.primary,
    detected: { git: detection.hasGit, jj: detection.hasJj },
    git: null,
    jj: null,
    generatedAtMs: Date.now(),
  };
  if (!detection.repoRoot) return snapshot;
  if (detection.hasGit) {
    try {
      const parsed = parseGitStatus(runLocal("git", ["status", "--porcelain=v1", "--branch"], detection.repoRoot));
      snapshot.git = {
        kind: "git",
        available: true,
        repoRoot: detection.repoRoot,
        current: parsed.current,
        bookmarks: parseBranches(runLocal("git", ["branch", "--format=%(refname:short)"], detection.repoRoot)),
        changes: parsed.changes,
        clean: parsed.clean,
        error: null,
      };
    } catch (error) {
      snapshot.git = unavailable("git", error);
    }
  }
  if (detection.hasJj) {
    try {
      const repoRoot = runLocal("jj", ["--no-pager", "root"], detection.repoRoot).trim() || detection.repoRoot;
      const parsed = parseJjStatus(runLocal("jj", ["--no-pager", "--color=never", "status"], detection.repoRoot));
      snapshot.jj = {
        kind: "jj",
        available: true,
        repoRoot,
        current: parsed.current,
        bookmarks: parseJjBookmarks(
          runLocal(
            "jj",
            ["--no-pager", "--color=never", "bookmark", "list", "--template", 'name ++ "\\n"'],
            detection.repoRoot,
          ),
        ),
        changes: parsed.changes,
        clean: parsed.clean,
        error: null,
      };
    } catch (error) {
      snapshot.jj = unavailable("jj", error);
    }
  }
  return snapshot;
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function fileApiError(res, status, code, message) {
  json(res, status, { error: { code, message } });
}

function parseHttpHost(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader.trim() === "") return null;
  try {
    return new URL(`http://${hostHeader}`);
  } catch {
    return null;
  }
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function isLoopbackHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized === "127.0.0.1" || normalized.startsWith("127.");
  return false;
}

function originMatchesHost(originHeader, hostHeader, localPort) {
  if (typeof originHeader !== "string" || originHeader.trim() === "") {
    return false;
  }
  const requestHost = parseHttpHost(hostHeader);
  if (!requestHost || !isLoopbackHostname(requestHost.hostname)) {
    return false;
  }
  const requestPort = Number(requestHost.port || "80");
  if (localPort && requestPort !== localPort) {
    return false;
  }

  let origin;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    return false;
  }
  if (!isLoopbackHostname(origin.hostname)) {
    return false;
  }
  if (normalizeHostname(origin.hostname) !== normalizeHostname(requestHost.hostname)) {
    return false;
  }
  return Number(origin.port || (origin.protocol === "https:" ? "443" : "80")) === requestPort;
}

/**
 * A cross-origin browser request to one of the reverse-proxies (the gateway or
 * the concierge). The proxies rewrite Host/Origin to a loopback origin, so a
 * cross-origin page could otherwise reach the unauthenticated local gateway or
 * concierge looking same-origin and drive them via a CORS "simple" request (CSRF
 * against run control / workflow creation). We mirror the gateway's own model: a
 * PRESENT Origin must match this server's loopback origin; an absent Origin
 * (same-origin GETs, non-browser CLI) is allowed.
 */
function isCrossOriginProxyRequest(req) {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.trim() === "") return false;
  return !originMatchesHost(origin, req.headers.host, req.socket.localPort);
}

function enforceFilesWriteSameOrigin(req, res) {
  if (originMatchesHost(req.headers.origin, req.headers.host, req.socket.localPort)) {
    return true;
  }
  fileApiError(res, 403, "FORBIDDEN_ORIGIN", "File write requests must come from the same local Smithers UI origin.");
  return false;
}

// True only when the request's Host header names a loopback origin bound to
// this server's port. Defeats DNS rebinding: a rebound hostname (e.g. an
// attacker domain that now resolves to 127.0.0.1) still sends its own
// non-loopback Host header even though the TCP socket is local.
function requestHostIsLoopback(req) {
  const requestHost = parseHttpHost(req.headers.host);
  if (!requestHost || !isLoopbackHostname(requestHost.hostname)) return false;
  const localPort = req.socket.localPort;
  if (localPort && Number(requestHost.port || "80") !== localPort) return false;
  return true;
}

// Guard for the local data endpoints (VCS snapshot, file tree/read, workspace
// readiness). These serve local source and repo state to same-origin GETs (no
// Origin header) and to the CLI, so we cannot require a matching Origin the way
// the write endpoint does. Instead we reject any request whose Host is not a
// loopback origin (DNS rebinding) and any request carrying a cross-origin
// Origin header.
function isLocalDataRequestAllowed(req) {
  return requestHostIsLoopback(req) && !isCrossOriginProxyRequest(req);
}

function realpathOrResolve(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isInsideRoot(root, target) {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function toWorkspaceRelative(root, target) {
  const rel = relative(root, target).split(sep).join("/");
  return rel === "" ? "" : rel;
}

export function resolveWorkspaceFilePath(workspaceRoot, inputPath, { mustExist = true } = {}) {
  if (typeof inputPath !== "string") {
    return {
      ok: false,
      status: 400,
      code: "INVALID_PATH",
      message: "Path must be a string.",
    };
  }
  if (inputPath.includes("\0")) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_PATH",
      message: "Path cannot contain NUL bytes.",
    };
  }

  const root = realpathOrResolve(workspaceRoot);
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath || ".");
  if (!isInsideRoot(root, candidate)) {
    return {
      ok: false,
      status: 403,
      code: "PATH_OUTSIDE_ROOT",
      message: "Path is outside the workspace root.",
    };
  }

  if (candidate !== root) {
    const parent = dirname(candidate);
    const parentReal = realpathOrResolve(parent);
    if (!isInsideRoot(root, parentReal)) {
      return {
        ok: false,
        status: 403,
        code: "PATH_OUTSIDE_ROOT",
        message: "Path parent is outside the workspace root.",
      };
    }
  }

  if (!existsSync(candidate)) {
    if (mustExist) {
      return {
        ok: false,
        status: 404,
        code: "PATH_NOT_FOUND",
        message: "Path was not found.",
      };
    }
    return {
      ok: true,
      root,
      absolutePath: candidate,
      realPath: candidate,
      relativePath: toWorkspaceRelative(root, candidate),
    };
  }

  const realPath = realpathOrResolve(candidate);
  if (!isInsideRoot(root, realPath)) {
    return {
      ok: false,
      status: 403,
      code: "PATH_OUTSIDE_ROOT",
      message: "Path resolves outside the workspace root.",
    };
  }
  return {
    ok: true,
    root,
    absolutePath: candidate,
    realPath,
    relativePath: toWorkspaceRelative(root, realPath),
  };
}

function detectBinary(buffer) {
  if (buffer.length === 0) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / buffer.length > 0.08;
}

function readPrefix(path, bytes) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function previewFlagsForFile(path, fileStat) {
  const sample = readPrefix(path, Math.min(FILE_PREVIEW_BYTES, fileStat.size));
  const binary = detectBinary(sample);
  return {
    binary,
    previewable: !binary,
    editable: !binary && fileStat.size <= FILE_EDIT_BYTES,
    truncated: !binary && fileStat.size > FILE_EDIT_BYTES,
    maxPreviewBytes: FILE_PREVIEW_BYTES,
    maxEditBytes: FILE_EDIT_BYTES,
  };
}

function entryForPath(root, childPath, name) {
  const lst = lstatSync(childPath);
  const rel = toWorkspaceRelative(root, childPath);
  const base = {
    name,
    path: rel,
    size: lst.size,
    mtimeMs: lst.mtimeMs,
    symlink: lst.isSymbolicLink(),
  };

  if (lst.isSymbolicLink()) {
    let real;
    try {
      real = realpathSync.native(childPath);
    } catch {
      return {
        ...base,
        type: "symlink",
        safe: false,
        previewable: false,
        editable: false,
      };
    }
    if (!isInsideRoot(root, real)) {
      return {
        ...base,
        type: "symlink",
        safe: false,
        previewable: false,
        editable: false,
      };
    }
    const st = statSync(real);
    return {
      ...base,
      type: st.isDirectory() ? "directory" : st.isFile() ? "file" : "other",
      size: st.size,
      mtimeMs: st.mtimeMs,
      safe: true,
      ...(!st.isDirectory() && st.isFile() ? previewFlagsForFile(real, st) : { previewable: false, editable: false }),
    };
  }

  if (lst.isDirectory()) {
    return {
      ...base,
      type: "directory",
      safe: true,
      previewable: false,
      editable: false,
    };
  }
  if (lst.isFile()) {
    return {
      ...base,
      type: "file",
      safe: true,
      ...previewFlagsForFile(childPath, lst),
    };
  }
  return {
    ...base,
    type: "other",
    safe: true,
    previewable: false,
    editable: false,
  };
}

function listWorkspaceTree(workspaceRoot, inputPath) {
  const resolved = resolveWorkspaceFilePath(workspaceRoot, inputPath);
  if (!resolved.ok) return resolved;
  const st = statSync(resolved.realPath);
  if (!st.isDirectory()) {
    return {
      ok: false,
      status: 400,
      code: "NOT_DIRECTORY",
      message: "Path is not a directory.",
    };
  }
  const allNames = readdirSync(resolved.realPath);
  const entries = allNames
    .map((name) => {
      try {
        return entryForPath(resolved.root, join(resolved.realPath, name), name);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, FILE_TREE_LIMIT);
  return {
    ok: true,
    root: basename(resolved.root),
    path: resolved.relativePath,
    entries,
    truncated: allNames.length > FILE_TREE_LIMIT,
  };
}

/**
 * A file's revision: the content hash `read` hands out and `write` requires
 * back. It is the optimistic-concurrency token — a save carrying a revision
 * that no longer matches the bytes on disk (an agent or another editor wrote
 * the file since the read) is rejected instead of clobbering the newer file.
 * Only fully-read editable files get one; binary and truncated previews are
 * not writable anyway.
 */
function fileRevision(bytes) {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

function readWorkspaceFile(workspaceRoot, inputPath) {
  const resolved = resolveWorkspaceFilePath(workspaceRoot, inputPath);
  if (!resolved.ok) return resolved;
  const st = statSync(resolved.realPath);
  if (!st.isFile()) {
    return {
      ok: false,
      status: 400,
      code: "NOT_FILE",
      message: "Path is not a file.",
    };
  }
  const flags = previewFlagsForFile(resolved.realPath, st);
  if (flags.binary) {
    return {
      ok: true,
      file: {
        path: resolved.relativePath,
        name: basename(resolved.realPath),
        size: st.size,
        mtimeMs: st.mtimeMs,
        revision: null,
        kind: "binary",
        editable: false,
        previewText: null,
        content: null,
        truncated: false,
        reason: "Binary files are not previewed in the editor.",
      },
    };
  }

  const fullRead = st.size <= FILE_EDIT_BYTES;
  const bytes = fullRead ? readFileSync(resolved.realPath) : readPrefix(resolved.realPath, FILE_PREVIEW_BYTES);
  const text = bytes.toString("utf8");
  return {
    ok: true,
    file: {
      path: resolved.relativePath,
      name: basename(resolved.realPath),
      size: st.size,
      mtimeMs: st.mtimeMs,
      revision: fullRead ? fileRevision(bytes) : null,
      kind: "text",
      editable: fullRead,
      previewText: text,
      content: fullRead ? text : null,
      truncated: !fullRead,
      reason: fullRead ? null : `Files larger than ${FILE_EDIT_BYTES} bytes open as read-only previews.`,
    },
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > FILE_EDIT_BYTES + 64 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Saves land in a sibling temp file that inherits the target's permission bits
 * and is then renamed over the target, so a reader (an agent, a watcher, the
 * editor itself) never observes a half-written file and a failed save leaves
 * the original bytes and mode untouched. The temp file is a sibling so the
 * rename stays within one filesystem — the only way it is atomic.
 */
function writeFileAtomicSync(targetPath, content, mode) {
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.smithers-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, content, { encoding: "utf8", mode });
    // writeFileSync's mode is masked by the process umask; set it outright.
    chmodSync(tempPath, mode);
    renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best effort: the target is already intact either way.
    }
    throw err;
  }
}

function writeWorkspaceFile(workspaceRoot, inputPath, content, revision) {
  if (typeof content !== "string") {
    return {
      ok: false,
      status: 400,
      code: "INVALID_CONTENT",
      message: "Content must be a string.",
    };
  }
  if (typeof revision !== "string" || revision === "") {
    return {
      ok: false,
      status: 400,
      code: "MISSING_REVISION",
      message: "Include the revision returned by the last read of this file.",
    };
  }
  if (Buffer.byteLength(content, "utf8") > FILE_EDIT_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "FILE_TOO_LARGE",
      message: "Content exceeds the editable file limit.",
    };
  }
  const resolved = resolveWorkspaceFilePath(workspaceRoot, inputPath);
  if (!resolved.ok) return resolved;
  const st = statSync(resolved.realPath);
  if (!st.isFile()) {
    return {
      ok: false,
      status: 400,
      code: "NOT_FILE",
      message: "Path is not a file.",
    };
  }
  const flags = previewFlagsForFile(resolved.realPath, st);
  if (!flags.editable) {
    return {
      ok: false,
      status: 415,
      code: "NOT_EDITABLE",
      message: "This file is not editable through the local UI.",
    };
  }
  if (fileRevision(readFileSync(resolved.realPath)) !== revision) {
    return {
      ok: false,
      status: 409,
      code: "STALE_REVISION",
      message: "This file changed on disk after you opened it. Reload it before saving.",
    };
  }
  try {
    writeFileAtomicSync(resolved.realPath, content, st.mode & 0o777);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      code: "WRITE_FAILED",
      message: `Could not save this file: ${err?.message ?? String(err)}`,
    };
  }
  return readWorkspaceFile(workspaceRoot, resolved.relativePath);
}

async function handleFilesApi(req, res, url, workspaceRoot) {
  try {
    if (req.method === "GET" && (url.pathname === "/api/files/tree" || url.pathname === "/api/files/read")) {
      if (!isLocalDataRequestAllowed(req)) {
        fileApiError(res, 403, "FORBIDDEN_ORIGIN", "File requests must come from the same local Smithers UI origin.");
        return true;
      }
    }
    if (url.pathname === "/api/files/tree" && req.method === "GET") {
      const result = listWorkspaceTree(workspaceRoot, url.searchParams.get("path") ?? "");
      if (!result.ok) fileApiError(res, result.status, result.code, result.message);
      else json(res, 200, result);
      return true;
    }
    if (url.pathname === "/api/files/read" && req.method === "GET") {
      const result = readWorkspaceFile(workspaceRoot, url.searchParams.get("path") ?? "");
      if (!result.ok) fileApiError(res, result.status, result.code, result.message);
      else json(res, 200, result);
      return true;
    }
    if (url.pathname === "/api/files/write" && req.method === "POST") {
      if (!enforceFilesWriteSameOrigin(req, res)) return true;
      try {
        const body = await readJsonBody(req);
        const result = writeWorkspaceFile(workspaceRoot, body.path, body.content, body.revision);
        if (!result.ok) fileApiError(res, result.status, result.code, result.message);
        else json(res, 200, result);
      } catch (err) {
        fileApiError(res, 400, "INVALID_REQUEST", err?.message ?? String(err));
      }
      return true;
    }
    if (url.pathname.startsWith(FILES_API_PREFIX)) {
      fileApiError(res, 404, "NOT_FOUND", "Unknown files API endpoint.");
      return true;
    }
    return false;
  } catch (err) {
    fileApiError(res, 500, "FILES_API_FAILED", err?.message ?? String(err));
    return true;
  }
}

/**
 * Connect-compatible wrapper around the production local files API. Vite uses
 * this in development and browser e2e so `/files` exercises the exact same
 * workspace containment, preview, and write implementation as `smithers ui`.
 */
export function localFilesMiddleware(workspaceRoot) {
  return async (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (await handleFilesApi(req, res, url, workspaceRoot)) return;
    next();
  };
}

async function realpathIfPossible(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function gatewayHealth(gatewayBase) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`${gatewayBase.replace(/\/+$/, "")}/health`, {
      signal: controller.signal,
    });
    return { reachable: res.ok, status: res.status };
  } catch (error) {
    return { reachable: false, error: error?.message ?? String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check whether a local workspace root is usable by this local UI server.
 * The static UI can only safely proxy one Gateway, so readiness is explicit
 * about both local setup and whether the proxied Gateway is scoped to the
 * selected root.
 */
export async function checkLocalWorkspaceReadiness({
  workspaceRoot,
  serverWorkspaceRoot = process.cwd(),
  gatewayBase,
}) {
  const input = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  const resolvedRoot = input ? resolve(input) : "";
  const resolvedServerRoot = resolve(serverWorkspaceRoot);
  const base = gatewayBase?.replace(/\/+$/, "") ?? "";

  if (!input) {
    return {
      status: "invalid-path",
      workspaceRoot: "",
      serverWorkspaceRoot: resolvedServerRoot,
      gatewayBase: base,
      gatewayReachable: false,
      missing: ["workspace root"],
      message: "Enter a local workspace root.",
    };
  }

  let rootStat;
  try {
    rootStat = await stat(resolvedRoot);
  } catch {
    return {
      status: "invalid-path",
      workspaceRoot: resolvedRoot,
      serverWorkspaceRoot: resolvedServerRoot,
      gatewayBase: base,
      gatewayReachable: false,
      missing: ["workspace directory"],
      message: `No local directory exists at ${resolvedRoot}.`,
    };
  }

  if (!rootStat.isDirectory()) {
    return {
      status: "invalid-path",
      workspaceRoot: resolvedRoot,
      serverWorkspaceRoot: resolvedServerRoot,
      gatewayBase: base,
      gatewayReachable: false,
      missing: ["workspace directory"],
      message: `${resolvedRoot} is not a directory.`,
    };
  }

  const [canonicalRoot, canonicalServerRoot] = await Promise.all([
    realpathIfPossible(resolvedRoot),
    realpathIfPossible(resolvedServerRoot),
  ]);
  const missing = [];
  try {
    const pack = await stat(join(canonicalRoot, ".smithers"));
    if (!pack.isDirectory()) missing.push(".smithers/");
  } catch {
    missing.push(".smithers/");
  }

  const health = await gatewayHealth(base);
  const scopedToSelectedRoot = canonicalRoot === canonicalServerRoot;
  let status = "ready";
  let message = "Local workspace is ready.";

  if (missing.length > 0) {
    status = "missing-setup";
    message = `Missing local Smithers setup: ${missing.join(", ")}. Run smithers init in this workspace.`;
  } else if (!health.reachable) {
    status = "gateway-unavailable";
    message = `No local Gateway is reachable at ${base}. Start smithers gateway for this workspace.`;
  } else if (!scopedToSelectedRoot) {
    status = "gateway-mismatch";
    message = `The local UI server is proxying a Gateway for ${canonicalServerRoot}, not ${canonicalRoot}. Start smithers ui --app from the selected workspace or choose ${canonicalServerRoot}.`;
  }

  return {
    status,
    workspaceRoot: canonicalRoot,
    serverWorkspaceRoot: canonicalServerRoot,
    gatewayBase: base,
    gatewayReachable: health.reachable,
    gatewayStatus: health.status ?? null,
    scopedToSelectedRoot,
    missing,
    message,
  };
}

/** Resolve a request path to a file inside dist, guarding against traversal. */
function resolveStaticFile(distDir, pathname) {
  const clean = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(distDir, clean);
  if (!filePath.startsWith(distDir)) return null;
  if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
  return null;
}

/**
 * Serve the bundle and reverse-proxy gateway traffic. Returns the listening
 * server. `gatewayBase` is e.g. `http://127.0.0.1:7331`.
 */
export function startLocalUiServer({
  distDir,
  gatewayBase,
  port,
  host = "127.0.0.1",
  conciergePort,
  workspaceRoot = process.cwd(),
}) {
  const gw = new URL(gatewayBase);
  const gatewayHost = gw.hostname;
  const gatewayPort = Number(gw.port || (gw.protocol === "https:" ? 443 : 80));
  const indexHtml = join(distDir, "index.html");

  const proxyTo = (req, res, targetHost, targetPort, onError) => {
    const headers = { ...req.headers, host: `${targetHost}:${targetPort}` };
    if (headers.origin) headers.origin = `http://${targetHost}:${targetPort}`;
    const proxyReq = httpRequest(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", onError);
    req.pipe(proxyReq);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === LOCAL_VCS_PATH) {
      if (!isLocalDataRequestAllowed(req)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Cross-origin requests are not allowed");
        return;
      }
      const workspacePath = process.env.SMITHERS_WORKSPACE_ROOT ?? workspaceRoot;
      const snapshot = readLocalVcsSnapshot(workspacePath);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (url.pathname.startsWith(FILES_API_PREFIX)) {
      void handleFilesApi(req, res, url, workspaceRoot);
      return;
    }
    if (url.pathname === LOCAL_WORKSPACE_PREFIX && req.method === "GET") {
      if (!isLocalDataRequestAllowed(req)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Cross-origin requests are not allowed");
        return;
      }
      void checkLocalWorkspaceReadiness({
        workspaceRoot,
        serverWorkspaceRoot: workspaceRoot,
        gatewayBase,
      })
        .then((readiness) =>
          json(res, 200, {
            ok: true,
            defaultWorkspaceRoot: readiness.serverWorkspaceRoot,
            readiness,
          }),
        )
        .catch((error) =>
          json(res, 500, {
            ok: false,
            error: error?.message ?? String(error),
          }),
        );
      return;
    }
    if (url.pathname === `${LOCAL_WORKSPACE_PREFIX}/readiness` && req.method === "POST") {
      if (!isLocalDataRequestAllowed(req)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Cross-origin requests are not allowed");
        return;
      }
      void readJsonBody(req)
        .then((body) =>
          checkLocalWorkspaceReadiness({
            workspaceRoot: body?.workspaceRoot,
            serverWorkspaceRoot: workspaceRoot,
            gatewayBase,
          }),
        )
        .then((readiness) => json(res, 200, { ok: true, readiness }))
        .catch((error) =>
          json(res, 400, {
            ok: false,
            error: error?.message ?? String(error),
          }),
        );
      return;
    }
    // The local concierge owns /api/chat (the chat backend).
    if (conciergePort && url.pathname.startsWith("/api/")) {
      if (!requestHostIsLoopback(req) || isCrossOriginProxyRequest(req)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Cross-origin requests are not allowed");
        return;
      }
      proxyTo(req, res, "127.0.0.1", conciergePort, () => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("Concierge unreachable");
      });
      return;
    }
    if (isGatewayPath(url.pathname)) {
      // Block cross-origin browsers BEFORE the Host/Origin rewrite, otherwise the
      // rewrite would hide their real origin from the gateway's own defense.
      if (!requestHostIsLoopback(req) || isCrossOriginProxyRequest(req)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Cross-origin gateway requests are not allowed");
        return;
      }
      // Reverse-proxy to the gateway, rewriting Host/Origin so the gateway sees
      // a same-origin loopback request (it may reject cross-origin upgrades).
      proxyTo(req, res, gatewayHost, gatewayPort, () => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("Gateway unreachable");
      });
      return;
    }

    // Static bundle. SPA fallback to index.html for client routes.
    const filePath = resolveStaticFile(distDir, url.pathname) ?? indexHtml;
    let body;
    try {
      body = readFileSync(filePath);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const type = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  });

  // WebSocket upgrades (the gateway RPC stream) — splice raw sockets through to
  // the gateway, rewriting the Host/Origin lines to keep it same-origin.
  server.on("upgrade", (req, clientSocket, head) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!isGatewayPath(url.pathname) || !requestHostIsLoopback(req) || isCrossOriginProxyRequest(req)) {
      clientSocket.destroy();
      return;
    }
    const upstream = netConnect(gatewayPort, gatewayHost, () => {
      let headerLines = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        let value = req.rawHeaders[i + 1];
        const lower = name.toLowerCase();
        if (lower === "host") value = `${gatewayHost}:${gatewayPort}`;
        if (lower === "origin") value = `http://${gatewayHost}:${gatewayPort}`;
        headerLines += `${name}: ${value}\r\n`;
      }
      upstream.write(headerLines + "\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePromise(server));
  });
}

/** Ask the OS for an available loopback port for this concierge session. */
export function allocateConciergePort() {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address !== "object") {
        probe.close();
        reject(new Error("Could not allocate an ephemeral concierge port."));
        return;
      }
      const ephemeralPort = address.port;
      probe.close((error) => (error ? reject(error) : resolvePromise(ephemeralPort)));
    });
  });
}

/**
 * Ensure the bundle is built (building from source if needed), then serve it.
 * Returns `{ server, url }`. Throws on unrecoverable errors.
 */
export async function serveLocalUi({ gatewayBase, port, rebuild = false }) {
  const ui = resolveLocalUi();
  if (!ui) {
    throw new Error(
      "Could not locate the Smithers UI app. Expected a prebuilt bundle at apps/cli/ui-dist or the source at apps/smithers.",
    );
  }
  const { distDir, appDir, viteBin } = ui;
  if (rebuild || !bundleIsFresh(distDir, appDir)) {
    if (appDir) {
      const ok = buildBundle(appDir, viteBin);
      if (!ok) throw new Error("Failed to build the local UI bundle.");
    } else if (!existsSync(join(distDir, "index.html"))) {
      throw new Error(`Prebuilt UI bundle missing at ${distDir}.`);
    }
  }
  // Start the local concierge (the chat backend) when its source is present, so
  // `smithers ui --app` serves a working chat that backgrounds workflows. It's
  // best-effort: a missing concierge just leaves /api/chat unproxied.
  let concierge = null;
  let conciergeStopping = false;
  let conciergePort;
  // The concierge (chat backend) runs from source in the repo, or from the
  // bundled `concierge.js` staged next to a prebuilt bundle. Either way it uses
  // Bun.serve, so it needs `bun` on PATH.
  const conciergeEntry = appDir ? join(appDir, "concierge", "server.ts") : join(distDir, "concierge.js");
  if (existsSync(conciergeEntry)) {
    // Block before we bind a port: an app whose chat can't work is worse than a
    // clear up-front error telling the user which env var to set.
    if (!hasConciergeCredential(process.env)) {
      throw new Error(MISSING_CREDENTIAL_MESSAGE);
    }
    if (!hasBunOnPath()) {
      throw new Error(MISSING_BUN_MESSAGE);
    }
    // Allocate a new port for every CLI session. A concierge orphaned by an
    // abnormal parent exit can no longer capture the next session's API proxy.
    conciergePort = await allocateConciergePort();
    concierge = spawn("bun", [conciergeEntry], {
      stdio: "ignore",
      env: {
        ...process.env,
        SMITHERS_CONCIERGE_PORT: String(conciergePort),
        SMITHERS_GATEWAY_PROXY_TARGET: gatewayBase,
      },
    });
    concierge.once("error", (error) => {
      console.error(`[smithers ui] Concierge failed to start: ${error?.message ?? String(error)}`);
    });
    concierge.once("exit", (code, signal) => {
      if (conciergeStopping) return;
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      console.error(`[smithers ui] Concierge died unexpectedly (${reason}); the chat API is unavailable.`);
    });
  }

  let server;
  try {
    server = await startLocalUiServer({
      distDir,
      gatewayBase,
      port,
      conciergePort,
      workspaceRoot: process.cwd(),
    });
  } catch (error) {
    // The concierge was already spawned above; a failed bind (e.g. EADDRINUSE)
    // would otherwise orphan it, leaking its port on every failed launch.
    conciergeStopping = true;
    concierge?.kill();
    throw error;
  }
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  // Tear the concierge down with the server.
  const close = server.close.bind(server);
  server.close = (...args) => {
    conciergeStopping = true;
    concierge?.kill();
    return close(...args);
  };
  return { server, url: `http://127.0.0.1:${actualPort}/`, distDir };
}

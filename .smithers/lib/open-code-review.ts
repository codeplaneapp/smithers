import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { z } from "zod/v4";

const DIFF_CONTEXT_LINES = 3;

const providerDirIgnoreDirs = [
  ".idea/",
  ".vscode/",
  ".svn/",
  ".git/",
  "vendor/",
  "node_modules/",
  "target/",
  ".happypack/",
  ".cachefile/",
  "_packages/",
  "rpm/",
  "pkgs/",
];

const supportedExtensions = new Set([
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".groovy",
  ".py",
  ".pyi",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hxx",
  ".cs",
  ".vb",
  ".fs",
  ".go",
  ".rs",
  ".rb",
  ".rake",
  ".gemspec",
  ".php",
  ".swift",
  ".m",
  ".mm",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".sql",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".vue",
  ".svelte",
  ".xml",
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".ini",
  ".env",
  ".gradle",
  ".cmake",
  ".r",
  ".lua",
  ".pl",
  ".pm",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".ets",
  ".json5",
  ".dart",
  ".tf",
]);

const defaultExcludePatterns = [
  "**/*_test.go",
  "**/src/test/java/**/*.java",
  "**/src/test/**/*.kt",
  "**/*.test.{js,jsx,ts,tsx}",
  "**/*.spec.{js,jsx,ts,tsx}",
  "**/__tests__/**",
  "**/test/**/*_test.py",
  "**/tests/**/*_test.py",
  "**/*_test.py",
  "**/*_spec.rb",
  "**/spec/**/*_spec.rb",
  "**/*Test.java",
  "**/*Tests.java",
  "**/*_test.rs",
  "**/oh_modules/**",
  "**/*.test.ets",
];

export const openCodeReviewInputSchema = z.object({
  repo: z.string().default("."),
  from: z.string().default(""),
  to: z.string().default(""),
  commit: z.string().default(""),
  background: z.string().default(""),
  rule: z.string().default(""),
  tools: z.string().default(""),
  concurrency: z.number().int().positive().default(8),
  timeout: z.number().int().positive().default(10),
  maxTools: z.number().int().nonnegative().default(0),
  ocrBin: z.string().default(process.env.OCR_BIN ?? "ocr"),
  runReview: z.boolean().default(true),
});

export type OpenCodeReviewInput = z.infer<typeof openCodeReviewInputSchema>;

export const reviewTargetSchema = z.object({
  repoDir: z.string(),
  mode: z.enum(["workspace", "range", "commit"]),
  ref: z.string(),
  ocrBin: z.string(),
  reviewArgs: z.array(z.string()),
});

export type ReviewTarget = z.infer<typeof reviewTargetSchema>;

export const previewEntrySchema = z.object({
  path: z.string(),
  status: z.string(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  willReview: z.boolean(),
  excludeReason: z.string().default(""),
});

export const previewOutputSchema = z.object({
  entries: z.array(previewEntrySchema),
  totalInsertions: z.number().int().nonnegative(),
  totalDeletions: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  reviewableCount: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
});

export type PreviewOutput = z.infer<typeof previewOutputSchema>;

export const reviewCommentSchema = z.object({
  path: z.string(),
  content: z.string().default(""),
  suggestionCode: z.string().default(""),
  existingCode: z.string().default(""),
  startLine: z.number().int().nonnegative().default(0),
  endLine: z.number().int().nonnegative().default(0),
  thinking: z.string().default(""),
});

export const warningSchema = z.object({
  file: z.string().default(""),
  message: z.string().default(""),
  type: z.string().default(""),
});

export const reviewSummarySchema = z.object({
  filesReviewed: z.number().int().nonnegative().default(0),
  comments: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  elapsed: z.string().default(""),
});

export const reviewRunOutputSchema = z.object({
  status: z.enum(["success", "skipped", "completed_with_warnings", "completed_with_errors", "failed"]),
  ok: z.boolean(),
  message: z.string().default(""),
  summary: reviewSummarySchema.nullable().default(null),
  comments: z.array(reviewCommentSchema),
  warnings: z.array(warningSchema).default([]),
  command: z.string(),
  exitCode: z.number().int(),
  stderr: z.string().default(""),
  error: z.string().default(""),
});

export type ReviewRunOutput = z.infer<typeof reviewRunOutputSchema>;

export const workflowSummarySchema = z.object({
  status: z.enum(["success", "skipped", "completed_with_warnings", "completed_with_errors", "failed"]),
  repoDir: z.string(),
  mode: z.string(),
  reviewableFiles: z.number().int().nonnegative(),
  excludedFiles: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  message: z.string(),
});

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type DiffRecord = {
  oldPath: string;
  newPath: string;
  diff: string;
  insertions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
};

type FileFilter = {
  include: string[];
  exclude: string[];
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeOpenCodeReviewInput(value: unknown): OpenCodeReviewInput {
  const record = isPlainRecord(value) ? { ...value } : {};
  for (const key of Object.keys(record)) {
    if (record[key] === null) delete record[key];
  }
  return openCodeReviewInputSchema.parse(record);
}

function camelizeRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeRecord);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())] = camelizeRecord(entry);
  }
  return out;
}

function commandLine(command: string, args: string[]) {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}

function trimForOutput(value: string, limit = 12_000) {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + "\n[truncated]";
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { cwd, env: process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolveCommand({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8") + `\nCommand timed out after ${timeoutMs}ms.`,
        exitCode: 124,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCommand({ stdout: "", stderr: err.message, exitCode: 127 });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCommand({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

async function git(repoDir: string, args: string[], timeoutMs = 120_000) {
  const result = await runCommand("git", ["-c", "core.quotepath=false", ...args], repoDir, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

export function reviewMode(input: OpenCodeReviewInput): ReviewTarget["mode"] {
  input = normalizeOpenCodeReviewInput(input);
  if (input.commit.trim()) return "commit";
  if (input.from.trim() || input.to.trim()) return "range";
  return "workspace";
}

export function validateReviewInput(input: OpenCodeReviewInput) {
  input = normalizeOpenCodeReviewInput(input);
  if ((input.from.trim() || input.to.trim()) && input.commit.trim()) {
    throw new Error("Only one review mode is allowed: workspace, --from/--to, or --commit.");
  }
  if (input.from.trim() && !input.to.trim()) {
    throw new Error("--to is required when --from is specified.");
  }
  if (!input.from.trim() && input.to.trim()) {
    throw new Error("--from is required when --to is specified.");
  }
}

export async function resolveReviewTarget(input: OpenCodeReviewInput): Promise<ReviewTarget> {
  input = normalizeOpenCodeReviewInput(input);
  validateReviewInput(input);
  const repoDir = resolve(input.repo || ".");
  await git(repoDir, ["rev-parse", "--git-dir"], 30_000);
  const mode = reviewMode(input);
  const ref =
    mode === "commit"
      ? input.commit.trim()
      : mode === "range"
        ? `${input.from.trim()}..${input.to.trim()}`
        : "workspace";
  const reviewArgs = buildReviewArgs(input, false);
  return { repoDir, mode, ref, ocrBin: input.ocrBin, reviewArgs };
}

export function buildReviewArgs(input: OpenCodeReviewInput, preview: boolean) {
  input = normalizeOpenCodeReviewInput(input);
  validateReviewInput(input);
  const args = ["review", "--repo", resolve(input.repo || ".")];
  if (input.from.trim()) args.push("--from", input.from.trim(), "--to", input.to.trim());
  if (input.commit.trim()) args.push("--commit", input.commit.trim());
  if (input.rule.trim()) args.push("--rule", resolve(input.rule.trim()));
  if (input.tools.trim()) args.push("--tools", resolve(input.tools.trim()));
  if (input.background.trim()) args.push("--background", input.background.trim());
  args.push("--concurrency", String(input.concurrency));
  args.push("--timeout", String(input.timeout));
  if (input.maxTools > 0) args.push("--max-tools", String(input.maxTools));
  if (preview) {
    args.push("--preview");
  } else {
    args.push("--format", "json", "--audience", "agent");
  }
  return args;
}

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open + 1);
  if (close < 0) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  return pattern
    .slice(open + 1, close)
    .split(",")
    .flatMap((option) => expandBraces(prefix + option + suffix));
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string) {
  let out = "^";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.slice(i, i + 3) === "**/") {
      out += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (pattern.slice(i, i + 2) === "**") {
      out += ".*";
      i += 2;
      continue;
    }
    if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    out += escapeRegex(pattern[i]);
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

export function globMatch(pattern: string, path: string) {
  return expandBraces(pattern).some((expanded) => globToRegExp(expanded).test(path));
}

function isAllowedExt(path: string) {
  const ext = extFromPath(path);
  return ext === "" || supportedExtensions.has(ext);
}

function extFromPath(path: string) {
  const name = path.split("/").pop() ?? path;
  const ext = extname(name);
  return ext.startsWith(".") ? ext.toLowerCase() : "";
}

function isDefaultExcluded(path: string) {
  const lower = path.toLowerCase();
  return defaultExcludePatterns.some((pattern) => globMatch(pattern, lower));
}

function loadGitignorePatterns(repoDir: string) {
  const path = join(repoDir, ".gitignore");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function gitignorePatternMatches(pattern: string, relPath: string) {
  if (pattern.startsWith("!")) return false;
  if (pattern.endsWith("/")) {
    const dirName = pattern.slice(0, -1);
    return relPath.split("/").includes(dirName);
  }
  if (!pattern.includes("/")) {
    return globMatch(pattern, relPath.split("/").pop() ?? relPath);
  }
  return globMatch(pattern, relPath) || relPath.endsWith(pattern);
}

function isProviderExcluded(path: string, gitignorePatterns: string[]) {
  for (const prefix of providerDirIgnoreDirs) {
    const dirPart = prefix.replace(/\/$/, "");
    if (path === dirPart || path.startsWith(prefix)) return true;
  }
  return gitignorePatterns.some((pattern) => gitignorePatternMatches(pattern, path));
}

function effectivePath(diff: DiffRecord) {
  return diff.newPath === "/dev/null" ? diff.oldPath : diff.newPath;
}

function diffStatus(diff: DiffRecord) {
  if (diff.isBinary) return "binary";
  if (diff.isNew) return "added";
  if (diff.isDeleted) return "deleted";
  if (diff.oldPath !== diff.newPath && diff.oldPath && diff.oldPath !== "/dev/null") return "renamed";
  return "modified";
}

function parseDiffText(diffText: string): DiffRecord[] {
  const lines = diffText.split("\n");
  const records: DiffRecord[] = [];
  let current: DiffRecord | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (!current) return;
    current.diff = buffer.join("\n").replace(/\n$/, "");
    records.push(current);
    buffer = [];
  };

  for (const line of lines) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      current = {
        oldPath: header[1],
        newPath: header[2],
        diff: "",
        insertions: 0,
        deletions: 0,
        isNew: false,
        isDeleted: false,
        isBinary: false,
      };
    }
    if (!current) continue;
    if (/^Binary files /.test(line)) current.isBinary = true;
    if (/^--- \/dev\/null$/.test(line) || /^--- a\/dev\/null$/.test(line)) current.isNew = true;
    if (/^\+\+\+ \/dev\/null$/.test(line) || /^\+\+\+ b\/dev\/null$/.test(line)) {
      current.isDeleted = true;
      current.newPath = "/dev/null";
    }
    if (line.startsWith("+") && !line.startsWith("+++")) current.insertions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
    buffer.push(line);
  }
  flush();
  return records;
}

async function workspaceDiffText(repoDir: string) {
  let tracked = "";
  const trackedResult = await runCommand(
    "git",
    ["-c", "core.quotepath=false", "diff", "HEAD", "--no-color", `-U${DIFF_CONTEXT_LINES}`, "--"],
    repoDir,
  );
  if (trackedResult.exitCode === 0 && trackedResult.stdout !== "") {
    tracked = trackedResult.stdout;
  } else {
    tracked = await git(repoDir, ["diff", "--staged", "--no-color", `-U${DIFF_CONTEXT_LINES}`, "--"]);
  }

  const untracked = await git(repoDir, ["ls-files", "--others", "--exclude-standard"]);
  const pieces = [tracked];
  for (const relPath of untracked.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const fullPath = join(repoDir, relPath);
    if (!existsSync(fullPath)) continue;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) continue;
    const content = readFileSync(fullPath);
    const text = content.toString("utf8");
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const lineCount = text.length === 0 ? 0 : lines.length;
    const addedLines = text.length > 0 ? lines.map((line) => `+${line}`) : [];
    const diffLines = [
      `diff --git a/${relPath} b/${relPath}`,
      "--- /dev/null",
      `+++ b/${relPath}`,
      `@@ -0,0 +1,${lineCount} @@`,
      ...addedLines,
    ];
    pieces.push(diffLines.join("\n"));
  }
  return pieces.filter(Boolean).join("\n\n");
}

async function loadDiffs(repoDir: string, input: OpenCodeReviewInput) {
  const mode = reviewMode(input);
  let diffText = "";
  if (mode === "range") {
    const base = (await git(repoDir, ["merge-base", input.from.trim(), input.to.trim()])).trim();
    if (!base) throw new Error(`Cannot find merge-base between ${input.from} and ${input.to}.`);
    diffText = await git(repoDir, ["diff", "--no-color", `-U${DIFF_CONTEXT_LINES}`, base, input.to.trim(), "--"]);
  } else if (mode === "commit") {
    diffText = await git(repoDir, ["show", "--no-color", `-U${DIFF_CONTEXT_LINES}`, input.commit.trim()]);
  } else {
    diffText = await workspaceDiffText(repoDir);
  }

  const gitignorePatterns = loadGitignorePatterns(repoDir);
  return parseDiffText(diffText).filter((diff) => !isProviderExcluded(effectivePath(diff), gitignorePatterns));
}

function readProjectRule(path: string): { include?: string[]; exclude?: string[] } | null {
  if (!path || !existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return {
    include: Array.isArray(record.include) ? record.include.filter((v): v is string => typeof v === "string") : [],
    exclude: Array.isArray(record.exclude) ? record.exclude.filter((v): v is string => typeof v === "string") : [],
  };
}

function buildFileFilter(repoDir: string, customRulePath: string): FileFilter | null {
  const candidates = [
    customRulePath ? readProjectRule(resolve(customRulePath)) : null,
    readProjectRule(join(repoDir, ".opencodereview", "rule.json")),
    readProjectRule(join(homedir(), ".opencodereview", "rule.json")),
  ];
  const picked = candidates.find((rule) => rule && ((rule.include?.length ?? 0) > 0 || (rule.exclude?.length ?? 0) > 0));
  if (!picked) return null;
  return {
    include: (picked.include ?? []).map((pattern) => pattern.toLowerCase()),
    exclude: (picked.exclude ?? []).map((pattern) => pattern.toLowerCase()),
  };
}

function isUserExcluded(filter: FileFilter | null, path: string) {
  if (!filter) return false;
  const lower = path.toLowerCase();
  return filter.exclude.some((pattern) => globMatch(pattern, lower));
}

function isUserIncluded(filter: FileFilter | null, path: string) {
  if (!filter || filter.include.length === 0) return false;
  const lower = path.toLowerCase();
  return filter.include.some((pattern) => globMatch(pattern, lower));
}

function whyExcluded(diff: DiffRecord, filter: FileFilter | null) {
  if (diff.isBinary) return "binary";
  const path = effectivePath(diff);
  if (isUserExcluded(filter, path)) return "user_exclude";
  if (!isAllowedExt(path)) return "unsupported_ext";
  if (filter && filter.include.length > 0 && isUserIncluded(filter, path)) return "";
  if (isDefaultExcluded(path)) return "default_path";
  return "";
}

export async function previewOpenCodeReview(input: OpenCodeReviewInput): Promise<PreviewOutput> {
  input = normalizeOpenCodeReviewInput(input);
  const target = await resolveReviewTarget(input);
  const filter = buildFileFilter(target.repoDir, input.rule.trim());
  const diffs = await loadDiffs(target.repoDir, input);
  const entries = diffs.map((diff) => {
    let excludeReason = whyExcluded(diff, filter);
    if (excludeReason === "" && diff.isDeleted) excludeReason = "deleted";
    return {
      path: effectivePath(diff),
      status: diffStatus(diff),
      insertions: diff.insertions,
      deletions: diff.deletions,
      willReview: excludeReason === "",
      excludeReason,
    };
  });
  return {
    entries,
    totalInsertions: diffs.reduce((sum, diff) => sum + diff.insertions, 0),
    totalDeletions: diffs.reduce((sum, diff) => sum + diff.deletions, 0),
    totalFiles: diffs.length,
    reviewableCount: entries.filter((entry) => entry.willReview).length,
    excludedCount: entries.filter((entry) => !entry.willReview).length,
  };
}

function parseJsonFromStdout(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("OCR produced no JSON output.");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("OCR output did not contain a JSON object.");
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
}

export function parseReviewJson(stdout: string): Omit<ReviewRunOutput, "command" | "exitCode" | "stderr" | "error" | "ok"> {
  const raw = camelizeRecord(parseJsonFromStdout(stdout));
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const parsedComments = Array.isArray(record.comments) ? record.comments : [];
  const status = typeof record.status === "string" ? record.status : "success";
  const normalized = {
    status,
    message: typeof record.message === "string" ? record.message : "",
    summary: record.summary ?? null,
    comments: parsedComments,
    warnings: Array.isArray(record.warnings) ? record.warnings : [],
  };
  return z
    .object({
      status: reviewRunOutputSchema.shape.status,
      message: z.string().default(""),
      summary: reviewSummarySchema.nullable().default(null),
      comments: z.array(reviewCommentSchema),
      warnings: z.array(warningSchema).default([]),
    })
    .parse(normalized);
}

export async function runOpenCodeReview(input: OpenCodeReviewInput, preview?: PreviewOutput): Promise<ReviewRunOutput> {
  input = normalizeOpenCodeReviewInput(input);
  const target = await resolveReviewTarget(input);
  if (!input.runReview) {
    return {
      status: "skipped",
      ok: true,
      message: "Review execution disabled by input.runReview.",
      summary: null,
      comments: [],
      warnings: [],
      command: commandLine(input.ocrBin, target.reviewArgs),
      exitCode: 0,
      stderr: "",
      error: "",
    };
  }
  if (preview && preview.reviewableCount === 0) {
    return {
      status: "skipped",
      ok: true,
      message: "No supported files changed.",
      summary: null,
      comments: [],
      warnings: [],
      command: commandLine(input.ocrBin, target.reviewArgs),
      exitCode: 0,
      stderr: "",
      error: "",
    };
  }

  const result = await runCommand(input.ocrBin, target.reviewArgs, target.repoDir, (input.timeout + 2) * 60_000);
  const command = commandLine(input.ocrBin, target.reviewArgs);
  if (result.exitCode !== 0) {
    return {
      status: "failed",
      ok: false,
      message: "OpenCodeReview failed.",
      summary: null,
      comments: [],
      warnings: [],
      command,
      exitCode: result.exitCode,
      stderr: trimForOutput(result.stderr),
      error: trimForOutput(result.stderr || result.stdout || "OpenCodeReview exited with a non-zero status."),
    };
  }

  try {
    const parsed = parseReviewJson(result.stdout);
    return {
      ...parsed,
      ok: parsed.status !== "failed",
      command,
      exitCode: result.exitCode,
      stderr: trimForOutput(result.stderr),
      error: "",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      ok: false,
      message: "Could not parse OpenCodeReview JSON output.",
      summary: null,
      comments: [],
      warnings: [],
      command,
      exitCode: result.exitCode,
      stderr: trimForOutput(result.stderr),
      error: message,
    };
  }
}

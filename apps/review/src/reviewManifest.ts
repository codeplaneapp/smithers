import { execFileSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { parseUnifiedPatch, reviewLineSet } from "./github/parsePatchCommentableLines";

export const REVIEW_MANIFEST_MAX_RECORDS = 3_000;
export const REVIEW_MANIFEST_MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const REVIEW_MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const MAX_PATH_UTF8_BYTES = 4 * 1024;
export function isSafeReviewPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024
    || value.startsWith("/") || value.includes("\0") || Buffer.byteLength(value) > MAX_PATH_UTF8_BYTES
    || value.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  // JSON can spell an unpaired UTF-16 surrogate even though Git paths arrive
  // as valid UTF-8. Reject representation-changing strings at every manifest
  // and artifact boundary.
  try { return decodeUtf8(Buffer.from(value), "review path") === value; }
  catch { return false; }
}
const SAFE_PATH = (value: string) => isSafeReviewPath(value);
const STATUSES = new Set(["A", "C", "D", "M", "R", "T"]);
const BLOB_MODES = new Set(["100644", "100755", "120000"]);
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_NAME_STATUS_BYTES = (REVIEW_MANIFEST_MAX_RECORDS + 1) * (2 * MAX_PATH_UTF8_BYTES + 16);
const MAX_TREE_BATCH_BYTES = 1024 * 1024;
export function compareReviewPaths(a: string, b: string): number {
  // Git orders pathnames as raw bytes, not JavaScript UTF-16 code units.
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export type ReviewManifestRecord = {
  oldPath: string;
  newPath: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch?: string;
  oldMode?: string;
  newMode?: string;
};

export type ReviewNameStatusRecord = Readonly<Pick<ReviewManifestRecord, "oldPath" | "newPath" | "filename" | "status">>;

export interface ReviewManifestGitRuntime {
  run(args: readonly string[], options: { maxBuffer: number; input?: string }): Uint8Array;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${label} is not valid UTF-8`); }
}

/** Strictly parse Git's terminal-NUL name-status protocol without creating an
 * unbounded split array. The 3,001st record is rejected before any tree/blob or
 * patch command is eligible to run. */
export function parseReviewNameStatus(rawInput: Uint8Array): readonly ReviewNameStatusRecord[] {
  const raw = Buffer.from(rawInput);
  if (raw.byteLength === 0) throw new Error("immutable review contains no changed files");
  if (raw.byteLength > MAX_NAME_STATUS_BYTES) throw new Error("Git name-status output is oversized");
  if (raw[raw.length - 1] !== 0) throw new Error("Git name-status output is not terminal-NUL delimited");
  let cursor = 0;
  const next = (): string => {
    const end = raw.indexOf(0, cursor);
    if (end < 0) throw new Error("Git name-status output is truncated");
    const value = decodeUtf8(raw.subarray(cursor, end), "Git name-status token");
    cursor = end + 1;
    if (!value) throw new Error("Git name-status output contains an empty token");
    return value;
  };
  const records: ReviewNameStatusRecord[] = [];
  while (cursor < raw.length) {
    const status = next();
    const kind = status[0];
    if (!/^(?:[ADMT]|[RC]\d{3})$/.test(status)
      || ((kind === "R" || kind === "C") && (Number(status.slice(1)) < 1 || Number(status.slice(1)) > 100))) {
      throw new Error("invalid Git name-status record");
    }
    const oldPath = next();
    const newPath = kind === "R" || kind === "C" ? next() : oldPath;
    if (!SAFE_PATH(oldPath) || !SAFE_PATH(newPath)
      || Buffer.byteLength(oldPath) > MAX_PATH_UTF8_BYTES || Buffer.byteLength(newPath) > MAX_PATH_UTF8_BYTES) {
      throw new Error("Git name-status path is unsafe or oversized");
    }
    records.push(Object.freeze({ oldPath, newPath, filename: newPath, status }));
    if (records.length > REVIEW_MANIFEST_MAX_RECORDS) throw new Error("immutable review exceeds 3,000 files");
  }
  if (records.length === 0) throw new Error("immutable review contains no changed files");
  if (new Set(records.map((item) => item.filename)).size !== records.length
    || records.some((item, index) => index > 0 && compareReviewPaths(records[index - 1].filename, item.filename) >= 0)) {
    throw new Error("Git name-status records are duplicate or noncanonical");
  }
  return Object.freeze(records);
}

function record(value: unknown): ReviewManifestRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest record is not an object");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const allowed = new Set(["additions", "binary", "deletions", "filename", "newPath", "newMode", "oldMode", "oldPath", "patch", "status"]);
  const required = ["additions", "binary", "deletions", "filename", "newPath", "oldPath", "status"];
  const prototype = Object.getPrototypeOf(input);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(input, key))) {
    throw new Error("manifest record has an invalid schema");
  }
  const { oldPath, newPath, filename, status, additions, deletions, binary, patch, oldMode, newMode } = input;
  if (typeof oldPath !== "string" || typeof newPath !== "string" || typeof filename !== "string"
    || !SAFE_PATH(oldPath) || !SAFE_PATH(newPath) || filename !== newPath
    || typeof status !== "string" || !STATUSES.has(status[0] ?? "") || !/^(?:[ADMT]|R\d{3}|C\d{3})$/.test(status)
    || typeof additions !== "number" || !Number.isSafeInteger(additions) || additions < 0
    || typeof deletions !== "number" || !Number.isSafeInteger(deletions) || deletions < 0
    || typeof binary !== "boolean" || (patch !== undefined && typeof patch !== "string")
    || (oldMode !== undefined && (typeof oldMode !== "string" || !BLOB_MODES.has(oldMode)))
    || (newMode !== undefined && (typeof newMode !== "string" || !BLOB_MODES.has(newMode)))) {
    throw new Error("manifest record has invalid fields");
  }
  if (binary && (patch !== undefined || additions !== 0 || deletions !== 0)) throw new Error("binary manifest records must be patchless and stat-free");
  const kind = status[0];
  if ((kind === "A" || kind === "D" || kind === "M" || kind === "T")
    && (oldPath !== filename || newPath !== filename)) {
    throw new Error("manifest status/path relationship is invalid");
  }
  if ((kind === "R" || kind === "C") && oldPath === newPath) throw new Error("rename manifest paths must differ");
  if ((kind === "R" || kind === "C") && (!/^[RC]\d{3}$/.test(status)
    || Number(status.slice(1)) < 1 || Number(status.slice(1)) > 100)) throw new Error(`rename score is invalid: ${status}`);
  if ((kind === "A" && (oldMode !== undefined || newMode === undefined))
    || (kind === "D" && (oldMode === undefined || newMode !== undefined))
    || ((kind === "M" || kind === "R" || kind === "C" || kind === "T") && (oldMode === undefined || newMode === undefined))
    || (kind === "T" && oldMode === newMode)) {
    throw new Error("manifest status and immutable blob modes are inconsistent");
  }
  if (patch !== undefined) {
    if (binary || !patch.startsWith("diff --git ")) {
      throw new Error("manifest patch is inconsistent with its record");
    }
    const parsedPatch = parseManifestPatch(patch, { oldPath, newPath, status, oldMode, newMode });
    if (parsedPatch.additions !== additions || parsedPatch.deletions !== deletions) {
      throw new Error("manifest patch statistics do not match its hunks");
    }
  }
  // A regular modification must either carry the text that grants inline
  // capabilities or be represented as a type-only (`T`) record.  Treating a
  // patchless M as mode-only would let a producer erase a text change.
  // Git calls a chmod-only change M.  Its canonical capability form is an M
  // record with no patch and no statistics; T is reserved for Git's actual
  // type-change name-status code and must not be invented by this layer.
  if (patch === undefined && !binary && kind === "M") {
    if (additions !== 0 || deletions !== 0 || oldMode === newMode) {
      throw new Error("patchless modified manifest records must be canonical mode-only changes");
    }
  }
  if (patch === undefined && !binary && kind === "T") {
    throw new Error("nonbinary type-change manifest records must carry a patch");
  }
  if (patch === undefined && !binary && kind !== "M") {
    throw new Error("nonbinary changed records must carry a bound patch");
  }
  if (patch !== undefined && Buffer.byteLength(patch) > REVIEW_MANIFEST_MAX_RECORD_BYTES) throw new Error("manifest patch is oversized");
  return Object.freeze({ oldPath, newPath, filename, status, additions, deletions, binary,
    ...(patch === undefined ? {} : { patch }),
    ...(oldMode === undefined ? {} : { oldMode }),
    ...(newMode === undefined ? {} : { newMode }),
  });
}

export function parseReviewManifest(text: string | Uint8Array): readonly ReviewManifestRecord[] {
  const bytes = typeof text === "string" ? Buffer.from(text) : Buffer.from(text);
  if (bytes.byteLength === 0 || bytes.byteLength > REVIEW_MANIFEST_MAX_BYTES) throw new Error("manifest is empty or oversized");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // The protected form is exact JSONL with no optional trailing record.  This
  // prevents two byte representations from describing the same capability.
  if (decoded.endsWith("\n")) throw new Error("manifest is not canonical JSONL");
  const lines: string[] = [];
  let lineStart = 0;
  for (;;) {
    const lineEnd = decoded.indexOf("\n", lineStart);
    if (lineEnd < 0) {
      lines.push(decoded.slice(lineStart));
      break;
    }
    lines.push(decoded.slice(lineStart, lineEnd));
    if (lines.length >= REVIEW_MANIFEST_MAX_RECORDS) throw new Error("manifest record count is outside 1..3000");
    lineStart = lineEnd + 1;
  }
  if (lines.length < 1 || lines.length > REVIEW_MANIFEST_MAX_RECORDS) throw new Error("manifest record count is outside 1..3000");
  const parsed = lines.map((line) => {
    if (!line || Buffer.byteLength(line) > REVIEW_MANIFEST_MAX_RECORD_BYTES) throw new Error("manifest record is empty or oversized");
    const item = record(JSON.parse(line));
    // JSON itself admits many spellings.  A protected capability manifest has
    // exactly one spelling, so signatures/readers cannot disagree over it.
    if (JSON.stringify(item) !== line) throw new Error("manifest record is not canonical JSONL");
    return item;
  });
  const names = parsed.map((item) => item.filename);
  if (new Set(names).size !== names.length || names.some((name, i) => i > 0 && compareReviewPaths(names[i - 1], name) >= 0)) {
    throw new Error("manifest filenames must be unique and sorted");
  }
  return Object.freeze(parsed);
}

type PatchExpectation = Pick<ReviewManifestRecord, "oldPath" | "newPath" | "status" | "oldMode" | "newMode">;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function gitToken(pathname: string): string {
  const bytes = Buffer.from(pathname, "utf8");
  // Git deliberately leaves ordinary spaces unquoted in diff/rename headers.
  if (![...bytes].some((byte) => byte < 0x20 || byte === 0x22 || byte === 0x5c || byte >= 0x7f)) return pathname;
  let quoted = "\"";
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c) quoted += `\\${String.fromCharCode(byte)}`;
    else if (byte === 0x0a) quoted += "\\n";
    else if (byte === 0x09) quoted += "\\t";
    else if (byte < 0x20 || byte >= 0x7f) quoted += `\\${byte.toString(8).padStart(3, "0")}`;
    else quoted += String.fromCharCode(byte);
  }
  return `${quoted}\"`;
}

function gitPath(prefix: string, pathname: string): string {
  return gitToken(`${prefix}/${pathname}`);
}

function fileHeaderPath(value: string): string {
  return value !== "/dev/null" && !value.startsWith("\"") && value.includes(" ") ? `${value}\t` : value;
}

/** Split only at a structural record boundary. A hunk payload can contain any
 * header-shaped text, but its first operation byte keeps it inside the hunk. */
function structuralPatchSections(lines: readonly string[]): string[][] {
  if (!lines[0]?.startsWith("diff --git ")) throw new Error("manifest patch has no Git record header");
  const sections: string[][] = [];
  let start = 0;
  let sawHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  let previousContent = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (oldRemaining > 0 || newRemaining > 0) {
      if (line === "\\ No newline at end of file") {
        if (!previousContent) throw new Error("manifest patch has a misplaced no-newline marker");
        previousContent = false;
        continue;
      }
      const first = line[0];
      if (first === " ") { oldRemaining -= 1; newRemaining -= 1; }
      else if (first === "+") newRemaining -= 1;
      else if (first === "-") oldRemaining -= 1;
      else throw new Error("manifest patch hunk is structurally invalid");
      if (oldRemaining < 0 || newRemaining < 0) throw new Error("manifest patch hunk count is invalid");
      previousContent = true;
      continue;
    }
    if (line === "\\ No newline at end of file") {
      if (!sawHunk || !previousContent) throw new Error("manifest patch has a misplaced no-newline marker");
      previousContent = false;
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      sawHunk = true;
      previousContent = false;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      sections.push(lines.slice(start, i));
      start = i;
      sawHunk = false;
      previousContent = false;
      continue;
    }
    if (sawHunk) throw new Error("manifest patch has content outside a completed hunk");
  }
  if (oldRemaining !== 0 || newRemaining !== 0) throw new Error("manifest patch hunk count is invalid");
  sections.push(lines.slice(start));
  return sections;
}

function parseIndex(line: string): { oldOid: string; newOid: string; mode?: string } {
  const match = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (100644|100755|120000))?$/.exec(line);
  if (!match || match[1].length !== match[2].length || (match[1].length !== 40 && match[1].length !== 64)) {
    throw new Error("manifest patch index metadata is noncanonical");
  }
  return { oldOid: match[1], newOid: match[2], ...(match[3] ? { mode: match[3] } : {}) };
}

function allZero(value: string): boolean { return /^0+$/.test(value); }

function parseManifestSection(section: readonly string[], expected: PatchExpectation): ReturnType<typeof parseUnifiedPatch> {
  const kind = expected.status[0];
  if (section[0] !== `diff --git ${gitPath("a", expected.oldPath)} ${gitPath("b", expected.newPath)}`) {
    throw new Error("manifest patch paths do not match its record");
  }
  const hunkIndex = section.findIndex((line, index) => index > 0 && HUNK_HEADER.test(line));
  const hasHunks = hunkIndex >= 0;
  let extendedEnd = hasHunks ? hunkIndex - 2 : section.length;
  if (hasHunks) {
    const oldName = kind === "A" ? "/dev/null" : gitPath("a", expected.oldPath);
    const newName = kind === "D" ? "/dev/null" : gitPath("b", expected.newPath);
    if (hunkIndex < 3
      || section[hunkIndex - 2] !== `--- ${fileHeaderPath(oldName)}`
      || section[hunkIndex - 1] !== `+++ ${fileHeaderPath(newName)}`) {
      throw new Error("manifest patch file headers do not match its record");
    }
  }
  if (extendedEnd < 1) throw new Error("manifest patch extended headers are missing");
  const extended = section.slice(1, extendedEnd);
  let cursor = 0;
  const take = (wanted: string): void => {
    if (extended[cursor++] !== wanted) throw new Error("manifest patch has noncanonical extended header order");
  };
  const modesDiffer = expected.oldMode !== undefined && expected.newMode !== undefined && expected.oldMode !== expected.newMode;
  if (kind === "M" || kind === "R" || kind === "C") {
    if (modesDiffer) { take(`old mode ${expected.oldMode}`); take(`new mode ${expected.newMode}`); }
  }
  if (kind === "A") take(`new file mode ${expected.newMode}`);
  else if (kind === "D") take(`deleted file mode ${expected.oldMode}`);
  else if (kind === "R" || kind === "C") {
    const verb = kind === "R" ? "rename" : "copy";
    take(`similarity index ${Number(expected.status.slice(1))}%`);
    take(`${verb} from ${gitToken(expected.oldPath)}`);
    take(`${verb} to ${gitToken(expected.newPath)}`);
  }

  let index: ReturnType<typeof parseIndex> | undefined;
  const needsIndex = kind === "A" || kind === "D" || kind === "M" || ((kind === "R" || kind === "C") && hasHunks);
  if (needsIndex) index = parseIndex(extended[cursor++] ?? "");
  if (cursor !== extended.length) throw new Error("manifest patch has duplicate or conflicting extended metadata");

  if (kind === "A") {
    if (!index || !allZero(index.oldOid) || allZero(index.newOid) || index.mode !== undefined) throw new Error("manifest added-file index is invalid");
  } else if (kind === "D") {
    if (!index || allZero(index.oldOid) || !allZero(index.newOid) || index.mode !== undefined) throw new Error("manifest deleted-file index is invalid");
  } else if (kind === "M") {
    if (!hasHunks || !index || allZero(index.oldOid) || allZero(index.newOid) || index.oldOid === index.newOid
      || (modesDiffer ? index.mode !== undefined : index.mode !== expected.oldMode)) {
      throw new Error("manifest modified-file index is invalid");
    }
  } else if (kind === "R" || kind === "C") {
    const score = Number(expected.status.slice(1));
    if (!hasHunks) {
      if (score !== 100 || index !== undefined) throw new Error("manifest pure rename/copy metadata is invalid");
    } else if (!index || allZero(index.oldOid) || allZero(index.newOid) || index.oldOid === index.newOid
      || (modesDiffer ? index.mode !== undefined : index.mode !== expected.oldMode)) {
      throw new Error("manifest edited rename/copy index is invalid");
    }
  } else {
    throw new Error("manifest patch status is unsupported");
  }

  if (!hasHunks) {
    if (kind !== "A" && kind !== "D" && kind !== "R" && kind !== "C") throw new Error("manifest patch unexpectedly has no hunks");
    return { additions: 0, deletions: 0, rightLines: reviewLineSet([]) };
  }
  return parseUnifiedPatch(`${section.join("\n")}\n`, { canonical: true });
}

/** Bind a unified patch to the immutable name-status record before hunk lines
 * become capabilities. Generation pins quoting and full object IDs. */
function parseManifestPatch(patch: string, expected: PatchExpectation): ReturnType<typeof parseUnifiedPatch> {
  if (!patch.endsWith("\n") || patch.endsWith("\n\n")) {
    throw new Error("manifest patch is not canonical Git text");
  }
  const sections = structuralPatchSections(patch.slice(0, -1).split("\n"));
  if (expected.status[0] === "T") {
    if (sections.length !== 2 || !expected.oldMode || !expected.newMode || expected.oldMode === expected.newMode) {
      throw new Error("manifest type-change patch is noncanonical");
    }
    const deleted = parseManifestSection(sections[0], {
      oldPath: expected.oldPath, newPath: expected.oldPath, status: "D", oldMode: expected.oldMode,
    });
    const added = parseManifestSection(sections[1], {
      oldPath: expected.newPath, newPath: expected.newPath, status: "A", newMode: expected.newMode,
    });
    return {
      additions: deleted.additions + added.additions,
      deletions: deleted.deletions + added.deletions,
      rightLines: added.rightLines,
    };
  }
  if (sections.length !== 1) throw new Error("manifest patch contains multiple Git records");
  return parseManifestSection(sections[0], expected);
}

/** Derive review capabilities from the already validated immutable record.
 * Never apply this to arbitrary GitHub patch text: a two-record patch is a
 * type transition only when the manifest status says so. */
export function deriveReviewManifestCapabilities(record: ReviewManifestRecord): ReturnType<typeof parseUnifiedPatch> {
  if (record.binary || !record.patch) {
    return { additions: 0, deletions: 0, rightLines: reviewLineSet([]) };
  }
  return parseManifestPatch(record.patch, record);
}

export function serializeReviewManifest(records: readonly ReviewManifestRecord[]): string {
  if (records.length < 1 || records.length > REVIEW_MANIFEST_MAX_RECORDS) throw new Error("manifest record count is outside 1..3000");
  const normalized = records.map(record);
  if (new Set(normalized.map((item) => item.filename)).size !== normalized.length
    || normalized.some((item, i) => i > 0 && compareReviewPaths(normalized[i - 1].filename, item.filename) >= 0)) {
    throw new Error("manifest filenames must be unique and sorted");
  }
  const lines = normalized.map((item) => {
    const line = JSON.stringify(item);
    // Escaping a hostile pathname/patch can grow substantially beyond its raw
    // bytes. The reader limits JSONL records, so the writer must too.
    if (Buffer.byteLength(line) > REVIEW_MANIFEST_MAX_RECORD_BYTES) throw new Error("serialized manifest record is oversized");
    return line;
  });
  const text = lines.join("\n");
  if (Buffer.byteLength(text) > REVIEW_MANIFEST_MAX_BYTES) throw new Error("manifest is oversized");
  return text;
}

export function readProtectedReviewManifest(path: string): readonly ReviewManifestRecord[] {
  const pathnameBefore = lstatSync(path);
  if (!pathnameBefore.isFile() || pathnameBefore.nlink !== 1 || (pathnameBefore.mode & 0o222) !== 0) {
    throw new Error("manifest path is not a protected regular file");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o222) !== 0
      || before.size < 1 || before.size > REVIEW_MANIFEST_MAX_BYTES) {
      throw new Error("manifest is not a bounded protected regular file");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("manifest ended while being read");
      offset += count;
    }
    const after = fstatSync(fd);
    const pathnameAfter = lstatSync(path);
    if (pathnameBefore.dev !== before.dev || pathnameBefore.ino !== before.ino
      || pathnameAfter.dev !== after.dev || pathnameAfter.ino !== after.ino
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.mode !== before.mode || after.nlink !== before.nlink
      || pathnameAfter.size !== pathnameBefore.size || pathnameAfter.mtimeMs !== pathnameBefore.mtimeMs
      || pathnameAfter.mode !== pathnameBefore.mode || pathnameAfter.nlink !== pathnameBefore.nlink) {
      throw new Error("manifest changed while being read");
    }
    return parseReviewManifest(bytes);
  } finally { closeSync(fd); }
}

/** Exclusively create a durable, read-only, single-link input capability. */
export function writeProtectedReviewInput(
  path: string,
  contents: string | Uint8Array,
  maxBytes = REVIEW_MANIFEST_MAX_BYTES,
): void {
  const bytes = typeof contents === "string" ? Buffer.from(contents) : Buffer.from(contents);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    throw new Error("protected review input is empty or oversized");
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
  let created: ReturnType<typeof fstatSync> | undefined;
  try {
    for (let offset = 0; offset < bytes.length;) {
      const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
      if (wrote <= 0) throw new Error("protected review input write did not make progress");
      offset += wrote;
    }
    fchmodSync(fd, 0o444);
    fsyncSync(fd);
    created = fstatSync(fd);
  } finally { closeSync(fd); }
  const named = lstatSync(path);
  if (!created || !named.isFile() || named.nlink !== 1 || (named.mode & 0o222) !== 0
    || named.dev !== created.dev || named.ino !== created.ino || named.size !== created.size) {
    throw new Error("protected review input pathname was replaced while being written");
  }
  // fsync the parent after the exclusive, no-follow create so the name is
  // durable too. Some platforms reject directory fsync; the file data has
  // already been synchronised and that portability failure is harmless.
  try {
    const dir = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (error) {
    // Directory fsync is unavailable on a few supported platforms. Do not
    // hide actual I/O failures, which would falsely report a durable write.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
  }
  // The pathname can still race while the parent directory is synchronised.
  // Reconcile it once more before reporting a durable protected capability.
  const durable = lstatSync(path);
  if (!created || !durable.isFile() || durable.nlink !== 1 || (durable.mode & 0o222) !== 0
    || durable.dev !== created.dev || durable.ino !== created.ino || durable.size !== created.size
    || durable.mtimeMs !== created.mtimeMs) {
    throw new Error("protected review input pathname changed while its directory was synchronized");
  }
}

export function writeProtectedReviewManifest(path: string, records: readonly ReviewManifestRecord[]): void {
  writeProtectedReviewInput(path, serializeReviewManifest(records));
}

export function manifestChangedFiles(records: readonly ReviewManifestRecord[]): Set<string> {
  return new Set(records.map((item) => item.filename));
}

export function generateReviewManifest(
  workspace: string,
  baseSha: string,
  headSha: string,
  runtime?: ReviewManifestGitRuntime,
): string {
  const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  if (!oidPattern.test(baseSha) || !oidPattern.test(headSha) || baseSha.length !== headSha.length) {
    throw new Error("immutable review revisions must be full, matching Git object IDs");
  }
  const git = (args: readonly string[], maxBuffer: number, input?: string): Buffer => {
    const output = runtime
      ? runtime.run(args, { maxBuffer, ...(input === undefined ? {} : { input }) })
      : execFileSync("git", [...args], {
        cwd: workspace,
        maxBuffer,
        ...(input === undefined
          ? { stdio: ["ignore", "pipe", "pipe"] as const }
          : { input, stdio: ["pipe", "pipe", "pipe"] as const }),
      });
    const bytes = Buffer.from(output);
    // A test/runtime adapter is held to the same contract as execFileSync.
    if (bytes.byteLength > maxBuffer) throw new Error("Git output exceeds its command boundary");
    return bytes;
  };
  const text = (args: readonly string[], maxBuffer: number, input?: string, label = "Git output") => (
    decodeUtf8(git(args, maxBuffer, input), label)
  );
  const mergeBaseOutput = text(["merge-base", "--end-of-options", baseSha, headSha], 256, undefined, "Git merge-base output");
  const mergeBaseMatch = /^([0-9a-f]{40}|[0-9a-f]{64})\n$/.exec(mergeBaseOutput);
  if (!mergeBaseMatch || mergeBaseMatch[1].length !== baseSha.length) throw new Error("Git merge-base output is noncanonical");
  const mergeBase = mergeBaseMatch[1];
  const raw = git([
    "-c", "diff.renameLimit=0", "diff", "--name-status", "-z", "--no-color",
    "--no-ext-diff", "--no-textconv", "--no-indent-heuristic", "--diff-algorithm=myers",
    "--find-renames", "--find-copies-harder", "-l0", "--end-of-options", mergeBase, headSha,
  ], MAX_NAME_STATUS_BYTES);
  const records: ReviewManifestRecord[] = parseReviewNameStatus(raw).map((item) => ({
    ...item, additions: 0, deletions: 0, binary: false,
  }));
  let serializedBytes = 0;
  const blobIds = new Map<string, string>();
  const blobModes = new Map<string, string>();
  const revisionPaths: ReadonlyArray<readonly [string, string[]]> = [
    [mergeBase, [...new Set(records.filter((item) => item.status[0] !== "A").map((item) => item.oldPath))].sort(compareReviewPaths)],
    [headSha, [...new Set(records.filter((item) => item.status[0] !== "D").map((item) => item.newPath))].sort(compareReviewPaths)],
  ];
  for (const [revision, paths] of revisionPaths) {
    // Keep every Git argv well below ARG_MAX. The manifest count gate above is
    // intentionally before these per-path operations, and batching preserves
    // deterministic reconciliation for exact-3000 changes.
    for (let offset = 0; offset < paths.length; offset += 128) {
      const batchPaths = paths.slice(offset, offset + 128);
      const tree = git(["--literal-pathspecs", "ls-tree", "-z", "--full-tree", revision, "--", ...batchPaths], MAX_TREE_BATCH_BYTES);
      if (tree.byteLength === 0) continue;
      const treeText = decodeUtf8(tree, "immutable tree output");
      if (!treeText.endsWith("\0")) throw new Error("immutable tree output is not terminal-NUL delimited");
      const expectedPaths = new Set(batchPaths);
      const seenPaths = new Set<string>();
      let treeCursor = 0;
      while (treeCursor < treeText.length) {
        const end = treeText.indexOf("\0", treeCursor);
        if (end < 0) throw new Error("immutable tree output is truncated");
        const entry = treeText.slice(treeCursor, end);
        treeCursor = end + 1;
        if (!entry) throw new Error("immutable tree output contains an empty record");
        const tab = entry.indexOf("\t");
        const header = tab < 0 ? "" : entry.slice(0, tab);
        const pathname = tab < 0 ? "" : entry.slice(tab + 1);
        const fields = /^(100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(header);
        if (!fields || fields[2].length !== baseSha.length || !SAFE_PATH(pathname)
          || Buffer.byteLength(pathname) > MAX_PATH_UTF8_BYTES || !expectedPaths.has(pathname) || seenPaths.has(pathname)) {
          throw new Error("immutable tree entry is invalid or unsupported");
        }
        seenPaths.add(pathname);
        blobIds.set(`${revision}\0${pathname}`, fields[2]);
        blobModes.set(`${revision}\0${pathname}`, fields[1]);
      }
    }
  }
  const objectIds = [...new Set(records.flatMap((item) => [
    blobIds.get(`${mergeBase}\0${item.oldPath}`), blobIds.get(`${headSha}\0${item.newPath}`),
  ]).filter((id): id is string => Boolean(id)))];
  if (objectIds.length === 0) throw new Error("immutable review has no blob objects");
  const objectInput = `${objectIds.join("\n")}\n`;
  // Validate every object and the aggregate byte budget before materialising
  // even one body. This also avoids one process per blob at the 3,000-file cap.
  const checked = text(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    MAX_TREE_BATCH_BYTES,
    objectInput,
    "immutable blob metadata",
  );
  if (!checked.endsWith("\n")) throw new Error("immutable blob metadata is truncated");
  const checkedLines = checked.slice(0, -1).split("\n");
  if (checkedLines.length !== objectIds.length) throw new Error("immutable blob metadata count is invalid");
  const sizeById = new Map<string, number>();
  let aggregateBlobBytes = 0;
  for (let index = 0; index < objectIds.length; index += 1) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob (0|[1-9]\d*)$/.exec(checkedLines[index]);
    const size = match ? Number(match[2]) : Number.NaN;
    if (!match || match[1] !== objectIds[index] || !Number.isSafeInteger(size) || size > MAX_BLOB_BYTES) {
      throw new Error("immutable blob metadata is invalid or exceeds the per-blob limit");
    }
    aggregateBlobBytes += size;
    if (!Number.isSafeInteger(aggregateBlobBytes) || aggregateBlobBytes > REVIEW_MANIFEST_MAX_BYTES) {
      throw new Error("immutable blobs exceed the aggregate limit");
    }
    sizeById.set(match[1], size);
  }

  const binaryById = new Map<string, boolean>();
  for (let groupStart = 0; groupStart < objectIds.length;) {
    const group: string[] = [];
    let groupBytes = 0;
    while (groupStart < objectIds.length && group.length < 256) {
      const candidate = objectIds[groupStart];
      const size = sizeById.get(candidate);
      if (size === undefined) throw new Error("immutable blob metadata reconciliation failed");
      if (group.length > 0 && groupBytes + size > MAX_BLOB_BATCH_BYTES) break;
      group.push(candidate);
      groupBytes += size;
      groupStart += 1;
    }
    const groupInput = `${group.join("\n")}\n`;
    const headerBudget = group.reduce((total, id) => total + Buffer.byteLength(id) + 64, 0);
    const batch = git(["cat-file", "--batch"], groupBytes + headerBudget, groupInput);
    let cursor = 0;
    for (const id of group) {
      const headerEnd = batch.indexOf(10, cursor);
      if (headerEnd < 0) throw new Error("immutable blob response is truncated");
      const headerBytes = batch.subarray(cursor, headerEnd);
      if (headerBytes.some((byte) => byte > 0x7f)) throw new Error("immutable blob response header is not ASCII");
      const header = headerBytes.toString("ascii");
      const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob (0|[1-9]\d*)$/.exec(header);
      const size = match ? Number(match[2]) : Number.NaN;
      if (!match || match[1] !== id || size !== sizeById.get(id)) throw new Error("immutable blob response is invalid");
      const start = headerEnd + 1;
      const end = start + size;
      if (end + 1 > batch.length || batch[end] !== 10) throw new Error("immutable blob response is oversized or truncated");
      const blob = batch.subarray(start, end);
      let genuineBinary = blob.includes(0);
      if (!genuineBinary) {
        try { decodeUtf8(blob, "immutable blob content"); }
        catch { genuineBinary = true; }
      }
      binaryById.set(id, genuineBinary);
      cursor = end + 1;
    }
    if (cursor !== batch.length) throw new Error("immutable blob response has trailing data");
  }
  let emptyBlobId: string | undefined;
  const requireEmptyBlobId = (): string => {
    if (emptyBlobId) return emptyBlobId;
    const output = text(["hash-object", "-w", "--stdin"], 256, "", "empty blob object ID");
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\n$/.exec(output);
    if (!match || match[1].length !== baseSha.length) throw new Error("empty blob object ID is noncanonical");
    emptyBlobId = match[1];
    return emptyBlobId;
  };
  const blobDiffHunks = (oldId: string, newId: string, label: string): string[] => {
    const blobPatch = text([
      "-c", "core.quotePath=true", "diff", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "--text",
      "--src-prefix=a/", "--dst-prefix=b/", "--no-indent-heuristic", "--diff-algorithm=myers", "--unified=3",
      "--no-renames", "--end-of-options", oldId, newId,
    ], REVIEW_MANIFEST_MAX_RECORD_BYTES, undefined, label);
    if (!blobPatch.endsWith("\n")) throw new Error(`${label} is truncated`);
    const lines = blobPatch.slice(0, -1).split("\n");
    if (lines[0] !== `diff --git a/${oldId} b/${newId}`
      || lines[1] !== `index ${oldId}..${newId} 100644`
      || lines[2] !== `--- a/${oldId}` || lines[3] !== `+++ b/${newId}`
      || !HUNK_HEADER.test(lines[4] ?? "")) {
      throw new Error(`${label} is noncanonical`);
    }
    return lines.slice(4);
  };
  for (const item of records) {
    const paths = item.oldPath === item.newPath ? [item.filename] : [item.oldPath, item.newPath];
    // Git attributes are head-controlled. Inspect the immutable blob bytes
    // directly so an adversarial `*.ts binary` cannot hide reviewable source.
    const oldBlobId = blobIds.get(`${mergeBase}\0${item.oldPath}`);
    const newBlobId = blobIds.get(`${headSha}\0${item.newPath}`);
    const oldMode = blobModes.get(`${mergeBase}\0${item.oldPath}`);
    const newMode = blobModes.get(`${headSha}\0${item.newPath}`);
    // A text/binary transition is not reviewable text even if one side alone
    // happens to decode.  Deletions/additions legitimately have one missing
    // side, but every present side is authoritative.
    const genuineBinary = Boolean((oldBlobId && binaryById.get(oldBlobId)) || (newBlobId && binaryById.get(newBlobId)));
    if (item.status[0] !== "A" && !oldBlobId) throw new Error("immutable old manifest blob is unavailable");
    if (item.status[0] !== "D" && !newBlobId) throw new Error("immutable new manifest blob is unavailable");
    if (item.status[0] === "A") {
      if (oldMode !== undefined || !newMode) throw new Error("immutable added-file modes are inconsistent");
      item.newMode = newMode;
    } else if (item.status[0] === "D") {
      if (!oldMode || newMode !== undefined) throw new Error("immutable deleted-file modes are inconsistent");
      item.oldMode = oldMode;
    } else {
      if (!oldMode || !newMode) throw new Error("immutable changed-file modes are unavailable");
      item.oldMode = oldMode;
      item.newMode = newMode;
    }
    const binary = genuineBinary;
    item.binary = binary;
    item.additions = 0;
    item.deletions = 0;
    if (binary) {
      const encoded = Buffer.byteLength(JSON.stringify(record(item)));
      if (encoded > REVIEW_MANIFEST_MAX_RECORD_BYTES || serializedBytes + (serializedBytes ? 1 : 0) + encoded > REVIEW_MANIFEST_MAX_BYTES) throw new Error("manifest is oversized");
      serializedBytes += (serializedBytes ? 1 : 0) + encoded;
      continue;
    }
    // Pin quoting as well as disabling textconv/attributes.  The parser uses
    // Git's byte-escaped syntax, so repository-local quotePath cannot change
    // a protected manifest's spelling.
    let patch: string;
    if (item.status[0] === "R" || item.status[0] === "C") {
      if (!oldBlobId || !newBlobId || !oldMode || !newMode) throw new Error("immutable rename blob binding is unavailable");
      const kind = item.status[0];
      const score = Number(item.status.slice(1));
      if ((score === 100) !== (oldBlobId === newBlobId)) throw new Error("immutable rename score and blob identity are inconsistent");
      const verb = kind === "R" ? "rename" : "copy";
      const headers = [`diff --git ${gitPath("a", item.oldPath)} ${gitPath("b", item.newPath)}`];
      if (oldMode !== newMode) headers.push(`old mode ${oldMode}`, `new mode ${newMode}`);
      headers.push(
        `similarity index ${score}%`,
        `${verb} from ${gitToken(item.oldPath)}`,
        `${verb} to ${gitToken(item.newPath)}`,
      );
      if (oldBlobId !== newBlobId) {
        headers.push(
          `index ${oldBlobId}..${newBlobId}${oldMode === newMode ? ` ${oldMode}` : ""}`,
          `--- ${fileHeaderPath(gitPath("a", item.oldPath))}`,
          `+++ ${fileHeaderPath(gitPath("b", item.newPath))}`,
          ...blobDiffHunks(oldBlobId, newBlobId, "immutable rename blob patch"),
        );
      }
      patch = `${headers.join("\n")}\n`;
      if (Buffer.byteLength(patch) > REVIEW_MANIFEST_MAX_RECORD_BYTES) throw new Error("immutable patch output is oversized");
    } else if (item.status[0] === "A" || item.status[0] === "D") {
      const added = item.status[0] === "A";
      const blobId = added ? newBlobId : oldBlobId;
      const mode = added ? newMode : oldMode;
      if (!blobId || !mode) throw new Error("immutable add/delete blob binding is unavailable");
      const zero = "0".repeat(blobId.length);
      const headers = [
        `diff --git ${gitPath("a", item.oldPath)} ${gitPath("b", item.newPath)}`,
        `${added ? "new file mode" : "deleted file mode"} ${mode}`,
        `index ${added ? zero : blobId}..${added ? blobId : zero}`,
      ];
      if (sizeById.get(blobId) !== 0) {
        const empty = requireEmptyBlobId();
        headers.push(
          `--- ${added ? "/dev/null" : fileHeaderPath(gitPath("a", item.oldPath))}`,
          `+++ ${added ? fileHeaderPath(gitPath("b", item.newPath)) : "/dev/null"}`,
          ...blobDiffHunks(added ? empty : blobId, added ? blobId : empty, "immutable add/delete blob patch"),
        );
      }
      patch = `${headers.join("\n")}\n`;
      if (Buffer.byteLength(patch) > REVIEW_MANIFEST_MAX_RECORD_BYTES) throw new Error("immutable patch output is oversized");
    } else {
      patch = text([
        "-c", "core.quotePath=true", "-c", "diff.renameLimit=0", "--literal-pathspecs", "diff",
        "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "--text",
        "--src-prefix=a/", "--dst-prefix=b/", "--no-indent-heuristic", "--diff-algorithm=myers", "--unified=3",
        "--find-renames", "--find-copies-harder", "-l0", "--end-of-options", mergeBase, headSha, "--", ...paths,
      ], REVIEW_MANIFEST_MAX_RECORD_BYTES, undefined, "immutable patch output");
    }
    if (/^@@ /m.test(patch) || item.status[0] === "A" || item.status[0] === "D" || item.status[0] === "R" || item.status[0] === "C" || item.status[0] === "T") {
      const parsed = parseManifestPatch(patch, item);
      item.additions = parsed.additions;
      item.deletions = parsed.deletions;
      item.patch = patch;
    } else if (item.status[0] === "M") {
      // A hunk-less M is only valid for the canonical Git chmod metadata
      // form. Keep the original name-status semantic; never rewrite it to T.
      if (!(patch.includes("old mode ") && patch.includes("new mode "))) {
        throw new Error("immutable text change has no reviewable patch");
      }
      if (oldMode === newMode) throw new Error("immutable mode-only change did not change mode");
    } else {
      throw new Error("immutable nonbinary change has no reviewable patch");
    }
    // Check the encoded record before retaining the next large patch. This is
    // the aggregate boundary, not merely a final serialization check.
    const encoded = Buffer.byteLength(JSON.stringify(record(item)));
    if (encoded > REVIEW_MANIFEST_MAX_RECORD_BYTES || serializedBytes + (serializedBytes ? 1 : 0) + encoded > REVIEW_MANIFEST_MAX_BYTES) throw new Error("manifest is oversized");
    serializedBytes += (serializedBytes ? 1 : 0) + encoded;
  }
  return serializeReviewManifest(records);
}

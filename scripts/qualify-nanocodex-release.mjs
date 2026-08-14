#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { NanocodexAgent } from "@smthrs/agents";

import { runNanocodexCapabilities } from "../packages/agents/internal/nanocodex/process.js";
import {
  NANOCODEX_BRIDGE_VERSION,
  NANOCODEX_SHIPPED_TARGETS,
  NANOCODEX_VERSION,
} from "../packages/agents/internal/nanocodex/protocol.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST_PATH = resolve(
  SCRIPT_DIR,
  "../packages/agents/tests/fixtures/nanocodex/source-build-v0.0.1.json",
);
const MAX_UNCOMPRESSED_ARCHIVE_BYTES = 64 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const MAX_ARCHIVE_ENTRIES = 10_000;
const METADATA_TIMEOUT_MS = 10_000;
const MAX_METADATA_OUTPUT_BYTES = 1024 * 1024;
const MAX_METADATA_STDERR_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const POSIX_USTAR_MAGIC = Buffer.from("ustar\0", "ascii");
const POSIX_USTAR_VERSION = Buffer.from("00", "ascii");

export const PINNED_SOURCE_BUILD = deepFreeze({
  schemaVersion: 1,
  baselineId: "smithers-nanocodex-source-build/v0.0.1/x86_64-unknown-linux-gnu",
  status: "qualified",
  source: {
    repository: "N0xMare/smithers-nanocodex",
    commit: "56d8b4fd54bf14e9f2874e5a010b8e301f8f695b",
    tree: "b8a092569e579c21e2ae288a470a6881022b61f2",
    cargoLockBlob: "808504efe6b6ea6c43705205ca3182be0dee1afe",
    rustVersion: "1.97.0",
  },
  artifact: {
    target: "x86_64-unknown-linux-gnu",
    fileName: "smithers-nanocodex-v0.0.1-x86_64-unknown-linux-gnu.tar.gz",
    sha256: "3348b8a7818b4c759748e2cf0ecc9e0e4857f33ef6c3a92417655bfc0c73fdff",
    sizeBytes: 6_286_499,
    maximumSizeBytes: 8 * 1024 * 1024,
    minimumGlibcVersion: "2.35",
  },
  contract: {
    bridgeVersion: "0.0.1",
    nanocodexVersion: "0.3.0",
    protocol: "smithers.nanocodex/1",
    checkpointCodec: "nanocodex.session-snapshot/1",
    snapshotVersion: 1,
    policyFingerprint: "smithers.nanocodex.policy-fingerprint/1",
  },
  qualification: {
    date: "2026-08-01",
    providerFreeAdapterPreflight: true,
    checks: [
      "source commit, tree, and Cargo.lock identity before build",
      "reproduced archive SHA-256, exact size, version, capabilities, and file layout",
      "Ubuntu 22.04 glibc compatibility smoke test",
      "network-isolated public Smithers adapter preflight",
    ],
  },
});

export const CONSUMER_PACKAGE_ROOTS = Object.freeze([
  "smithers-nanocodex-v0.0.2-x86_64-unknown-linux-gnu",
  "smithers-nanocodex-v0.0.2-aarch64-apple-darwin",
]);

export const EXPECTED_CAPABILITIES = deepFreeze({
  bridgeVersion: NANOCODEX_BRIDGE_VERSION,
  target: "x86_64-unknown-linux-gnu",
  nanocodexVersion: NANOCODEX_VERSION,
  protocol: { name: "smithers.nanocodex", versions: [1] },
  checkpoint: {
    codec: "nanocodex.session-snapshot",
    codecVersions: [1],
    snapshotVersions: [1],
    continuationModes: ["resume"],
    resumeRequiresSameCanonicalWorkspace: true,
  },
  authenticationModes: ["api-key-env", "chatgpt"],
  transportModes: ["websocket"],
  models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  defaultModel: "gpt-5.6-sol",
  thinkingLevels: ["none", "low", "medium", "high", "xhigh", "max"],
  defaultThinking: "high",
  reasoningModes: ["standard", "pro"],
  features: {
    codeMode: true,
    codeModeDisable: false,
    websocketHttpsFallback: true,
    customEndpoints: false,
    mcp: false,
    subagents: false,
    steering: false,
    workspaceRelocation: false,
  },
  limits: {
    maxInputRecordBytes: 25_165_824,
    maxOutputRecordBytes: 41_943_040,
    maxPromptBytes: 4_194_304,
    maxSnapshotBytes: 15_728_640,
    maxEventBytes: 1_048_576,
    maxEventTotalBytes: 16_777_216,
    maxStderrBytes: 65_536,
    maxCommandRecords: 256,
    maxJsonDepth: 64,
    maxJsonNodes: 262_144,
    maxJsonObjectMembers: 16_384,
    maxJsonArrayElements: 131_072,
    maxJsonStringBytes: 18_874_368,
    maxJsonKeyBytes: 1_024,
    maxManagedAuthFileBytes: 1_048_576,
  },
});

/** Load the immutable Smithers consumer pin. */
export async function loadReleaseManifest(path = DEFAULT_MANIFEST_PATH) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read Nanocodex release manifest at ${path}.`, { cause: error });
  }
  if (stableJson(manifest) !== stableJson(PINNED_SOURCE_BUILD)) {
    throw new Error("Nanocodex release manifest does not match the immutable v0.0.1 consumer pin.");
  }
  return manifest;
}

/** Bound and digest the pinned-source artifact before any archive member is used. */
export function verifyArchiveIdentity(archive, artifact = PINNED_SOURCE_BUILD.artifact) {
  if (!Buffer.isBuffer(archive)) throw new TypeError("Nanocodex release archive must be a Buffer.");
  if (archive.byteLength === 0 || archive.byteLength > artifact.maximumSizeBytes) {
    throw new Error(
      `Nanocodex pinned-source archive must contain 1-${artifact.maximumSizeBytes} bytes; received ${archive.byteLength}.`,
    );
  }
  return createHash("sha256").update(archive).digest("hex");
}

/**
 * Parse the tar ourselves so no untrusted member reaches the filesystem before
 * layout, type, checksum, and path validation. Extended headers and every link
 * type are rejected; the qualified archive needs only POSIX regular files and
 * directories under one exact package root.
 */
export function inspectReleaseArchive(archive, manifest) {
  let tar;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_UNCOMPRESSED_ARCHIVE_BYTES });
  } catch (error) {
    throw new Error("Nanocodex archive is not a bounded valid gzip stream.", { cause: error });
  }

  const allowedRoots = packageRootsFrom(manifest);
  let packageRoot;
  let binaryMember;
  const entries = new Map();
  let binary;
  let offset = 0;
  let entryCount = 0;
  let sawEnd = false;

  while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      if (offset + TAR_BLOCK_BYTES * 2 > tar.byteLength || !isZeroBlock(tar.subarray(offset + 512, offset + 1024))) {
        throw new Error("Nanocodex tar terminator is incomplete.");
      }
      if (!isZeroBlock(tar.subarray(offset))) throw new Error("Nanocodex tar contains data after its terminator.");
      sawEnd = true;
      break;
    }
    if (++entryCount > MAX_ARCHIVE_ENTRIES) throw new Error("Nanocodex tar has too many entries.");
    assertTarChecksum(header);
    if (
      !header.subarray(257, 263).equals(POSIX_USTAR_MAGIC) ||
      !header.subarray(263, 265).equals(POSIX_USTAR_VERSION)
    ) {
      throw new Error("Nanocodex tar member is not an exact POSIX ustar entry.");
    }

    const name = readTarPath(header);
    const type = String.fromCharCode(header[156] || 0x30);
    if (!packageRoot) {
      const top = firstPathSegment(name);
      if (!top || !allowedRoots.includes(top)) {
        throw new Error(
          top
            ? `Nanocodex tar package root is not a shipped v0.0.2 target: ${JSON.stringify(top)}.`
            : `Nanocodex tar contains unsafe member path ${JSON.stringify(name)}.`,
        );
      }
      packageRoot = top;
      binaryMember = `${packageRoot}/smithers-nanocodex`;
    }
    if (type !== "0" && type !== "5") {
      throw new Error(`Nanocodex tar member ${JSON.stringify(name)} has forbidden type ${JSON.stringify(type)}.`);
    }
    const normalized = validateMemberPath(name, type, packageRoot);
    if (entries.has(normalized))
      throw new Error(`Nanocodex tar contains duplicate member ${JSON.stringify(normalized)}.`);

    const size = readTarOctal(header, 124, 12, "size");
    const mode = readTarOctal(header, 100, 8, "mode");
    if (type === "5" && size !== 0) throw new Error(`Nanocodex tar directory ${JSON.stringify(name)} has data.`);
    const dataOffset = offset + TAR_BLOCK_BYTES;
    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (!Number.isSafeInteger(paddedSize) || dataOffset + paddedSize > tar.byteLength) {
      throw new Error(`Nanocodex tar member ${JSON.stringify(name)} exceeds the archive boundary.`);
    }
    const kind = type === "5" ? "directory" : "file";
    entries.set(normalized, { kind, mode, size });
    if (normalized === binaryMember) {
      if (kind !== "file" || size === 0 || (mode & 0o111) === 0) {
        throw new Error("Nanocodex archive executable must be a non-empty executable regular file.");
      }
      binary = Buffer.from(tar.subarray(dataOffset, dataOffset + size));
    }
    offset = dataOffset + paddedSize;
  }

  if (!sawEnd) throw new Error("Nanocodex tar is missing its two-block terminator.");
  if (entries.get(packageRoot)?.kind !== "directory") {
    throw new Error("Nanocodex tar must declare its exact top-level package directory.");
  }
  for (const [path, entry] of entries) {
    for (const ancestor of ancestors(path)) {
      if (entries.get(ancestor)?.kind === "file") {
        throw new Error(
          `Nanocodex tar member ${JSON.stringify(path)} descends from regular file ${JSON.stringify(ancestor)}.`,
        );
      }
    }
    if (entry.kind === "directory" && path === binaryMember) {
      throw new Error("Nanocodex archive executable cannot be a directory.");
    }
  }
  if (!binary) throw new Error(`Nanocodex tar is missing regular executable ${binaryMember}.`);
  return { binary, binaryMember, entries: [...entries.entries()], packageRoot };
}

export function validateRuntimeMetadata(versionOutput, capabilities) {
  const expectedVersionOutput = `smithers-nanocodex ${EXPECTED_CAPABILITIES.bridgeVersion}\n`;
  if (versionOutput !== expectedVersionOutput) {
    throw new Error(`Nanocodex version mismatch: expected ${JSON.stringify(expectedVersionOutput)}.`);
  }
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error("Nanocodex capabilities do not match the fixed v0.0.2 Smithers surface.");
  }
  if (!NANOCODEX_SHIPPED_TARGETS.includes(capabilities.target)) {
    throw new Error("Nanocodex capabilities do not match the fixed v0.0.2 Smithers surface.");
  }
  const comparable = { ...capabilities, target: EXPECTED_CAPABILITIES.target };
  if (stableJson(comparable) !== stableJson(EXPECTED_CAPABILITIES)) {
    throw new Error("Nanocodex capabilities do not match the fixed v0.0.2 Smithers surface.");
  }
}

/**
 * Run both fixed metadata commands through the same direct-spawn capability
 * supervisor used by the adapter. The captured text is decoded without
 * normalization so qualification validates the bridge's exact stdout.
 */
export async function probeRuntimeMetadata(binary, cwd, runMetadataProbeImpl = runSupervisedMetadataProbe) {
  const processOptions = Object.freeze({
    binary,
    cwd,
    env: Object.freeze({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
    inheritEnv: false,
    maxOutputBytes: MAX_METADATA_OUTPUT_BYTES,
    maxStderrBytes: MAX_METADATA_STDERR_BYTES,
    timeoutMs: METADATA_TIMEOUT_MS,
  });
  let versionOutput;
  try {
    versionOutput = decodeMetadataOutput(
      await runMetadataProbeImpl({ ...processOptions, args: ["--version"] }),
      "version",
    );
  } catch {
    throw new Error("Nanocodex version probe failed.");
  }

  let capabilitiesOutput;
  try {
    capabilitiesOutput = decodeMetadataOutput(
      await runMetadataProbeImpl({ ...processOptions, args: ["capabilities", "--json"] }),
      "capabilities",
    );
  } catch {
    throw new Error("Nanocodex capabilities probe failed.");
  }

  let capabilities;
  try {
    capabilities = JSON.parse(capabilitiesOutput);
  } catch {
    throw new Error("Nanocodex capabilities output is not JSON.");
  }
  return { capabilities, capabilitiesOutput, versionOutput };
}

/**
 * Adapt one exact metadata argv to the repository's capability supervisor
 * without adding a second child-process implementation. The supervisor always
 * launches `capabilities --json`; the private launcher replaces itself with
 * the intended `--version` or `capabilities --json` command.
 */
export async function runSupervisedMetadataProbe(options, runSupervisedImpl = runNanocodexCapabilities) {
  assertMetadataProbeOptions(options);
  const launcherDirectory = await mkdtemp(join(options.cwd, ".smithers-nanocodex-metadata-"));
  const launcher = join(launcherDirectory, "probe");
  try {
    await writeFile(launcher, metadataLauncherSource(options.binary, options.args), { flag: "wx", mode: 0o755 });
    return await runSupervisedImpl({
      command: launcher,
      cwd: options.cwd,
      env: options.env,
      inheritEnv: false,
      maxOutputBytes: options.maxOutputBytes,
      maxStderrBytes: options.maxStderrBytes,
      timeoutMs: options.timeoutMs,
    });
  } finally {
    await rm(launcherDirectory, { recursive: true, force: true });
  }
}

export function assertSupportedQualificationHost(report = process.report?.getReport?.()) {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { hostTarget: "aarch64-apple-darwin", glibcVersion: null };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return {
      hostTarget: "x86_64-unknown-linux-gnu",
      glibcVersion: assertSupportedGlibc("2.35", report),
    };
  }
  throw new Error("Nanocodex release qualification requires Linux x86_64 (glibc 2.35+) or macOS arm64.");
}

export function assertSupportedGlibc(minimumVersion, report = process.report?.getReport?.()) {
  const runtimeVersion = report?.header?.glibcVersionRuntime;
  if (typeof runtimeVersion !== "string") {
    throw new Error("Nanocodex qualification requires a glibc-based Node.js runtime.");
  }
  if (compareVersions(runtimeVersion, minimumVersion) < 0) {
    throw new Error(`Nanocodex requires glibc ${minimumVersion} or newer; found ${runtimeVersion}.`);
  }
  return runtimeVersion;
}

export function compareVersions(left, right) {
  const parse = (value) => {
    if (typeof value !== "string" || !/^\d+(?:\.\d+)*$/.test(value)) throw new TypeError("Invalid numeric version.");
    return value.split(".").map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function parseArgs(argv) {
  let archivePath;
  let help = false;
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--archive") {
      if (seen.has("archive")) throw new Error("--archive may only be specified once.");
      seen.add("archive");
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--archive requires a path.");
      archivePath = resolve(value);
    } else if (argument === "--help" || argument === "-h") {
      if (seen.has("help")) throw new Error("--help may only be specified once.");
      seen.add("help");
      help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (help) return { help: true };
  if (!archivePath) throw new Error("--archive is required; pass a local v0.0.2 archive.");
  return { archivePath };
}

/** Verify and provider-independently preflight the pinned-source bridge. */
export async function qualifyNanocodexRelease({ archivePath } = {}) {
  const host = assertSupportedQualificationHost();
  const manifest = await loadReleaseManifest();
  if (typeof archivePath !== "string" || archivePath.length === 0) {
    throw new Error("Nanocodex qualification requires a local v0.0.2 archive.");
  }
  const archive = await readPinnedArchive(archivePath, manifest.artifact.maximumSizeBytes);
  const sha256 = verifyArchiveIdentity(archive, { maximumSizeBytes: manifest.artifact.maximumSizeBytes });
  const inspected = inspectReleaseArchive(archive);
  return await withQualificationScratch(inspected.binary, async ({ binary, scratch }) => {
    await preflightVerifiedBinary(binary, scratch);

    return qualificationResult({
      archivePath,
      glibcVersion: host.glibcVersion,
      sha256,
      sizeBytes: archive.byteLength,
      target: targetFromPackageRoot(inspected.packageRoot),
    });
  });
}

/**
 * Validate the supervised metadata surface before exercising the same extracted
 * executable through the public Smithers adapter. The injectable collaborators
 * keep the ordering and failure boundary deterministic in unit tests.
 */
export async function preflightVerifiedBinary(
  binary,
  scratch,
  manifest = PINNED_SOURCE_BUILD,
  { probeRuntimeMetadataImpl = probeRuntimeMetadata, NanocodexAgentImpl = NanocodexAgent } = {},
) {
  const { capabilities, versionOutput } = await probeRuntimeMetadataImpl(binary, scratch);
  validateRuntimeMetadata(versionOutput, capabilities, manifest);
  await preflightPublicNanocodexAdapter(binary, scratch, NanocodexAgentImpl);
}

/** Run the provider-free public adapter preflight with no ambient state or credential. */
export async function preflightPublicNanocodexAdapter(binary, scratch, NanocodexAgentImpl = NanocodexAgent) {
  try {
    const agent = new NanocodexAgentImpl({
      binary,
      cwd: scratch,
      env: {},
      inheritEnv: false,
    });
    await agent.preflight({ rootDir: scratch });
  } catch {
    throw new Error("Nanocodex public adapter preflight failed.");
  }
}

/** Preserve the existing stable success JSON surface and key order. */
export function qualificationResult({ archivePath, glibcVersion, manifest = PINNED_SOURCE_BUILD, sha256, sizeBytes, target }) {
  const pinnedSourceBuild = sha256 === manifest.artifact.sha256 && sizeBytes === manifest.artifact.sizeBytes;
  return {
    archive: resolve(archivePath),
    artifactProvenance: pinnedSourceBuild ? "pinned-source-build-sha256" : "unverified-input",
    bridgeVersion: EXPECTED_CAPABILITIES.bridgeVersion,
    glibcVersion,
    providerFreePreflight: true,
    sha256,
    sizeBytes,
    sourceCommit: pinnedSourceBuild ? manifest.source.commit : null,
    sourceTree: pinnedSourceBuild ? manifest.source.tree : null,
    target: target ?? manifest.artifact.target,
  };
}

/** Materialize verified binary bytes for qualification and always remove them. */
export async function withQualificationScratch(binaryBytes, callback) {
  const scratch = await mkdtemp(join(tmpdir(), "smithers-nanocodex-qualification-"));
  const binary = join(scratch, "smithers-nanocodex");
  try {
    await writeFile(binary, binaryBytes, { mode: 0o755, flag: "wx" });
    return await callback({ binary, scratch });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function readPinnedArchive(path, maximumBytes) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Nanocodex offline archive must be a regular file.");
    if (metadata.size === 0 || metadata.size > maximumBytes) {
      throw new Error(
        `Nanocodex pinned-source archive must contain 1-${maximumBytes} bytes; received ${metadata.size}.`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function decodeMetadataOutput(output, label) {
  if (!Buffer.isBuffer(output)) throw new TypeError(`Nanocodex ${label} probe did not return bytes.`);
  return UTF8_DECODER.decode(output);
}

function assertMetadataProbeOptions(options) {
  if (!options || typeof options !== "object") throw new TypeError("Nanocodex metadata probe options are required.");
  if (typeof options.binary !== "string" || options.binary.length === 0) {
    throw new TypeError("Nanocodex metadata binary must be explicit.");
  }
  if (typeof options.cwd !== "string" || options.cwd.length === 0) {
    throw new TypeError("Nanocodex metadata cwd must be explicit.");
  }
  if (!options.env || typeof options.env !== "object" || Array.isArray(options.env)) {
    throw new TypeError("Nanocodex metadata environment must be explicit.");
  }
  if (options.inheritEnv !== false) throw new TypeError("Nanocodex metadata probes must not inherit ambient state.");
  const exactArgs = JSON.stringify(options.args);
  if (exactArgs !== '["--version"]' && exactArgs !== '["capabilities","--json"]') {
    throw new TypeError("Nanocodex metadata probe arguments are not qualified.");
  }
}

function metadataLauncherSource(binary, args) {
  const command = [binary, ...args].map(shellQuote).join(" ");
  return `#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != "capabilities" ] || [ "$2" != "--json" ]; then
  exit 64
fi
exec ${command}
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readTarPath(header) {
  const name = readTarText(header, 0, 100);
  const prefix = readTarText(header, 345, 155);
  if (!name) throw new Error("Nanocodex tar contains an empty member path.");
  return prefix ? `${prefix}/${name}` : name;
}

function readTarText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  try {
    return UTF8_DECODER.decode(field.subarray(0, nul === -1 ? field.length : nul));
  } catch (error) {
    throw new Error("Nanocodex tar contains invalid UTF-8 metadata.", { cause: error });
  }
}

function readTarOctal(header, offset, length, label) {
  const field = readTarText(header, offset, length).trim();
  if (!/^[0-7]+$/.test(field)) throw new Error(`Nanocodex tar ${label} is not canonical octal.`);
  const value = Number.parseInt(field, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Nanocodex tar ${label} is out of range.`);
  return value;
}

function assertTarChecksum(header) {
  const recorded = readTarOctal(header, 148, 8, "checksum");
  let calculated = 0;
  for (let index = 0; index < header.length; index++) {
    calculated += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (recorded !== calculated) throw new Error("Nanocodex tar header checksum mismatch.");
}

function validateMemberPath(path, type, packageRoot) {
  if (path.includes("\\") || path.startsWith("/") || path.includes("\0")) {
    throw new Error(`Nanocodex tar contains unsafe member path ${JSON.stringify(path)}.`);
  }
  const normalized = type === "5" && path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Nanocodex tar contains unsafe member path ${JSON.stringify(path)}.`);
  }
  if (normalized !== packageRoot && !normalized.startsWith(`${packageRoot}/`)) {
    throw new Error(`Nanocodex tar member escapes the exact package root: ${JSON.stringify(path)}.`);
  }
  return normalized;
}

function ancestors(path) {
  const values = [];
  let end = path.lastIndexOf("/");
  while (end > 0) {
    values.push(path.slice(0, end));
    end = path.lastIndexOf("/", end - 1);
  }
  return values;
}

function isZeroBlock(buffer) {
  return buffer.every((byte) => byte === 0);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function packageRootsFrom(manifest) {
  if (manifest?.artifact?.fileName) {
    const root = manifest.artifact.fileName.replace(/\.tar\.gz$/, "");
    if (!root || root === manifest.artifact.fileName) {
      throw new Error("Nanocodex manifest archive name must end in .tar.gz.");
    }
    return [root];
  }
  return CONSUMER_PACKAGE_ROOTS;
}

function targetFromPackageRoot(packageRoot) {
  if (packageRoot === "smithers-nanocodex-v0.0.2-aarch64-apple-darwin") return "aarch64-apple-darwin";
  if (packageRoot === "smithers-nanocodex-v0.0.2-x86_64-unknown-linux-gnu") return "x86_64-unknown-linux-gnu";
  return undefined;
}

function firstPathSegment(path) {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return normalized.split("/")[0] ?? "";
}

function usage() {
  return `Usage: node ${basename(fileURLToPath(import.meta.url))} --archive /path/to/smithers-nanocodex-v0.0.2-<target>.tar.gz

Current v0.0.2 archives are reported as unverified-input because this command
does not embed published sidecar digests. This command never downloads release
artifacts.`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await qualifyNanocodexRelease(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

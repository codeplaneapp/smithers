#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { NanocodexAgent } from "@smithers-orchestrator/agents";

import { runNanocodexCapabilities } from "../packages/agents/internal/nanocodex/process.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST_PATH = resolve(
  SCRIPT_DIR,
  "../packages/agents/tests/fixtures/nanocodex/source-build-v0.0.1.json",
);
const MAX_UNCOMPRESSED_ARCHIVE_BYTES = 64 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const MAX_ARCHIVE_ENTRIES = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_REDIRECTS = 3;
const METADATA_TIMEOUT_MS = 10_000;
const MAX_METADATA_OUTPUT_BYTES = 1024 * 1024;
const MAX_METADATA_STDERR_BYTES = 64 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const POSIX_USTAR_MAGIC = Buffer.from("ustar\0", "ascii");
const POSIX_USTAR_VERSION = Buffer.from("00", "ascii");

export const PINNED_SOURCE_BUILD = deepFreeze({
  schemaVersion: 1,
  baselineId: "smithers-nanocodex-source-build/v0.0.1/x86_64-unknown-linux-gnu",
  status: "qualified",,
  artifact: {
    target: "x86_64-unknown-linux-gnu",
    fileName: "smithers-nanocodex-v0.0.1-x86_64-unknown-linux-gnu.tar.gz",
    downloadUrl:
      "https://github.com/N0xMare/smithers-nanocodex/releases/download/v0.0.1/smithers-nanocodex-v0.0.1-x86_64-unknown-linux-gnu.tar.gz",
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

export const EXPECTED_CAPABILITIES = deepFreeze({
  bridgeVersion: "0.0.1",
  target: "x86_64-unknown-linux-gnu",
  nanocodexVersion: "0.3.0",
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
export function inspectReleaseArchive(archive, manifest = PINNED_SOURCE_BUILD) {
  let tar;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_UNCOMPRESSED_ARCHIVE_BYTES });
  } catch (error) {
    throw new Error("Nanocodex archive is not a bounded valid gzip stream.", { cause: error });
  }

  const packageRoot = manifest.artifact.fileName.replace(/\.tar\.gz$/, "");
  if (!packageRoot || packageRoot === manifest.artifact.fileName) {
    throw new Error("Nanocodex manifest archive name must end in .tar.gz.");
  }
  const binaryMember = `${packageRoot}/smithers-nanocodex`;
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
  return { binary, binaryMember, entries: [...entries.entries()] };
}

export function validateRuntimeMetadata(versionOutput, capabilities, manifest = PINNED_SOURCE_BUILD) {
  const expectedVersionOutput = `smithers-nanocodex ${manifest.contract.bridgeVersion}\n`;
  if (versionOutput !== expectedVersionOutput) {
    throw new Error(`Nanocodex version mismatch: expected ${JSON.stringify(expectedVersionOutput)}.`);
  }
  if (stableJson(capabilities) !== stableJson(EXPECTED_CAPABILITIES)) {
    throw new Error("Nanocodex capabilities do not match the fixed v0.0.1 Smithers surface.");
  }
}

/**
 * Run both fixed metadata commands through the exact supervised Bubblewrap
 * capability runner. The captured text is decoded without normalization so
 * qualification validates the bridge's exact stdout.
 */
export async function probeRuntimeMetadata(binary, cwd, runContainedProbeImpl = runContainedMetadataProbe) {
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
      await runContainedProbeImpl({ ...processOptions, args: ["--version"] }),
      "version",
    );
  } catch {
    throw new Error("Nanocodex version probe failed.");
  }

  let capabilitiesOutput;
  try {
    capabilitiesOutput = decodeMetadataOutput(
      await runContainedProbeImpl({ ...processOptions, args: ["capabilities", "--json"] }),
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
 * Adapt one exact metadata argv to the repository's authoritative capability
 * runner without adding a second, less rigorous child-process implementation.
 * The private launcher is itself the Bubblewrap payload and replaces itself
 * with the verified bridge, so the downloaded executable never runs above the
 * containment/supervision boundary.
 */
export async function runContainedMetadataProbe(options, runSupervisedImpl = runNanocodexCapabilities) {
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
  if (!archivePath) throw new Error("--archive is required; build it from the pinned source commit.");
  return { archivePath };
}

/** Verify and provider-independently preflight the pinned-source bridge. */
export async function qualifyNanocodexRelease({ archivePath, fetchImpl = globalThis.fetch } = {}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Nanocodex release qualification requires Linux x64.");
  }
  const manifest = await loadReleaseManifest();
  const glibcVersion = assertSupportedGlibc(manifest.artifact.minimumGlibcVersion);
  if (typeof archivePath !== "string" || archivePath.length === 0) {
    throw new Error("Nanocodex qualification requires an archive built from the pinned source commit.");
  }
  const archive = await readPinnedArchive(archivePath, manifest.artifact.maximumSizeBytes);
  const sha256 = verifyArchiveIdentity(archive, manifest.artifact);
  const inspected = inspectReleaseArchive(archive, manifest);
  return await withQualificationScratch(inspected.binary, async ({ binary, scratch }) => {
    await preflightVerifiedBinary(binary, scratch, manifest);

    return qualificationResult({ archivePath, glibcVersion, manifest, sha256, sizeBytes: archive.byteLength });
  });
}

/**
 * Validate the contained metadata surface before exercising the same extracted
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
export function qualificationResult({ archivePath, glibcVersion, manifest, sha256, sizeBytes }) {
  const pinnedSourceBuild = sha256 === manifest.artifact.sha256 && sizeBytes === manifest.artifact.sizeBytes;
  return {
    archive: archivePath ? resolve(archivePath) : manifest.artifact.downloadUrl,
    artifactProvenance: pinnedSourceBuild ? "pinned-source-build-sha256" : "unverified-input",
    bridgeVersion: manifest.contract.bridgeVersion,
    glibcVersion,
    providerFreePreflight: true,
    sha256,
    sizeBytes,
    sourceCommit: pinnedSourceBuild ? manifest.source.commit : null,
    sourceTree: pinnedSourceBuild ? manifest.source.tree : null,
    target: manifest.artifact.target,
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

export async function downloadArchive(
  url,
  exactBytes,
  fetchImpl,
  { timeoutMs = DOWNLOAD_TIMEOUT_MS, maxRedirects = MAX_DOWNLOAD_REDIRECTS } = {},
) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required to download Nanocodex.");
  if (!Number.isSafeInteger(exactBytes) || exactBytes < 0) throw new TypeError("Pinned archive size is invalid.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("Download timeout is invalid.");
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new TypeError("Redirect limit is invalid.");

  let currentUrl = validateDownloadUrl(new URL(url), { initial: true });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Nanocodex archive download timed out after ${timeoutMs}ms.`)),
    timeoutMs,
  );

  try {
    for (let redirects = 0; ; redirects++) {
      const response = await fetchImpl(currentUrl.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "smithers-nanocodex-qualifier/1" },
      });

      if (isRedirectStatus(response.status)) {
        await response.body?.cancel();
        if (redirects >= maxRedirects) {
          throw new Error(`Nanocodex archive download exceeded ${maxRedirects} redirects.`);
        }
        const location = response.headers.get("location");
        if (!location) throw new Error(`Nanocodex archive redirect HTTP ${response.status} has no Location header.`);
        currentUrl = validateDownloadUrl(new URL(location, currentUrl), { initial: false });
        continue;
      }

      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Nanocodex archive download failed with HTTP ${response.status}.`);
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && contentLength !== String(exactBytes)) {
        await response.body.cancel();
        throw new Error(
          `Nanocodex archive Content-Length mismatch: expected ${exactBytes}, received ${JSON.stringify(contentLength)}.`,
        );
      }

      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > exactBytes) throw new Error(`Nanocodex archive download exceeds pinned size ${exactBytes}.`);
        chunks.push(buffer);
      }
      if (bytes !== exactBytes) {
        throw new Error(`Nanocodex archive download size mismatch: expected ${exactBytes}, received ${bytes}.`);
      }
      return Buffer.concat(chunks, bytes);
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(`Nanocodex archive download timed out after ${timeoutMs}ms.`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function validateDownloadUrl(url, { initial }) {
  if (url.protocol !== "https:") throw new Error("Nanocodex release URL and redirects must use HTTPS.");
  if (url.username || url.password || url.port) {
    throw new Error("Nanocodex release URL and redirects must not contain credentials or a custom port.");
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error(`Nanocodex release redirect host is not allowed: ${url.hostname}.`);
  }
  if (initial && url.href !== PINNED_RELEASE.artifact.downloadUrl) {
    throw new Error("Nanocodex release download must use the immutable v0.0.1 URL.");
  }
  return url;
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
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

function usage() {
  return `Usage: node ${basename(fileURLToPath(import.meta.url))} [--archive /path/to/${PINNED_SOURCE_BUILD.artifact.fileName}]

  
  Only the pinned SHA-256 receives source-build provenance; other bounded inputs
  are reported as unverified. This command never downloads release artifacts.`;
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

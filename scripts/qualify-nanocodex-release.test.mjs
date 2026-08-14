import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, test } from "node:test";

import {
  EXPECTED_CAPABILITIES,
  PINNED_SOURCE_BUILD,
  assertSupportedQualificationHost,
  compareVersions,
  inspectReleaseArchive,
  loadReleaseManifest,
  parseArgs,
  preflightVerifiedBinary,
  probeRuntimeMetadata,
  qualificationResult,
  runSupervisedMetadataProbe,
  validateRuntimeMetadata,
  verifyArchiveIdentity,
  withQualificationScratch,
} from "./qualify-nanocodex-release.mjs";

const ROOT = "smithers-nanocodex-v0.0.2-x86_64-unknown-linux-gnu";
const DARWIN_ROOT = "smithers-nanocodex-v0.0.2-aarch64-apple-darwin";

describe("Nanocodex release qualification", () => {
  test("keeps the prepared v0.0.2 consumer contract digest-free and dual-target", async () => {
    const prepared = JSON.parse(
      await readFile(
        new URL("../packages/agents/tests/fixtures/nanocodex/release-v0.0.2.json", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(prepared.release.version, "0.0.2");
    assert.equal(prepared.contract.bridgeVersion, EXPECTED_CAPABILITIES.bridgeVersion);
    assert.equal(prepared.contract.nanocodexVersion, EXPECTED_CAPABILITIES.nanocodexVersion);
    assert.equal(prepared.contract.toolProfile, "nanocodex-stock-0.5.0");
    assert.deepEqual(
      prepared.artifacts.map((artifact) => artifact.target),
      ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"],
    );
    assert.equal(
      prepared.artifacts.every((artifact) => !artifact.sha256 && !artifact.sizeBytes),
      true,
    );
    assert.match(prepared.qualification.notes, /does not duplicate those digests/);
  });

  test("loads the immutable source-build pin without a published-release checksum claim", async () => {
    const manifest = await loadReleaseManifest();
    assert.deepEqual(manifest, PINNED_SOURCE_BUILD);
    assert.equal(manifest.source.commit, "56d8b4fd54bf14e9f2874e5a010b8e301f8f695b");
    assert.equal(manifest.source.tree, "b8a092569e579c21e2ae288a470a6881022b61f2");
    assert.equal(manifest.artifact.sha256, "3348b8a7818b4c759748e2cf0ecc9e0e4857f33ef6c3a92417655bfc0c73fdff");
    assert.equal(manifest.artifact.sizeBytes, 6_286_499);
    assert.equal(manifest.artifact.maximumSizeBytes, 8 * 1024 * 1024);
    assert.equal(manifest.artifact.minimumGlibcVersion, "2.35");
    assert.equal(manifest.qualification.providerFreeAdapterPreflight, true);
  });

  test("deep-freezes every nested release and capability value", () => {
    assert.equal(Object.isFrozen(PINNED_SOURCE_BUILD), true);
    assert.equal(Object.isFrozen(EXPECTED_CAPABILITIES), true);
    assert.equal(Object.isFrozen(PINNED_SOURCE_BUILD.source), true);
    assert.equal(Object.isFrozen(PINNED_SOURCE_BUILD.qualification.checks), true);
    assert.equal(Object.isFrozen(EXPECTED_CAPABILITIES.protocol.versions), true);
    assert.equal(Object.isFrozen(EXPECTED_CAPABILITIES.features), true);
    assert.throws(() => {
      PINNED_SOURCE_BUILD.source.commit = "tampered";
    }, TypeError);
    assert.throws(() => PINNED_SOURCE_BUILD.qualification.checks.push("tampered"), TypeError);
    assert.throws(() => {
      EXPECTED_CAPABILITIES.features.codeMode = false;
    }, TypeError);
    assert.throws(() => EXPECTED_CAPABILITIES.authenticationModes.push("tampered"), TypeError);
  });

  test("parses an explicit offline archive and rejects ambiguous CLI arguments", () => {
    assert.throws(() => parseArgs([]), /--archive is required/);
    const archivePath = parseArgs(["--archive", "release.tar.gz"]).archivePath;
    assert.equal(isAbsolute(archivePath), true);
    assert.equal(basename(archivePath), "release.tar.gz");
    assert.deepEqual(parseArgs(["--help"]), { help: true });
    assert.throws(() => parseArgs(["--archive"]), /requires a path/);
    assert.throws(() => parseArgs(["--archive", "one.tar.gz", "--archive", "two.tar.gz"]), /only be specified once/);
    assert.throws(() => parseArgs(["--help", "-h"]), /only be specified once/);
    assert.throws(() => parseArgs(["--download"]), /Unknown argument/);
  });

  test("accepts one exact package root containing an executable regular binary", () => {
    const archive = tar([
      entry(`${ROOT}/`, "5"),
      entry(`${ROOT}/README.md`, "0", "read me"),
      entry(`${ROOT}/smithers-nanocodex`, "0", "ELF fixture", 0o755),
    ]);
    const inspected = inspectReleaseArchive(archive);
    assert.equal(inspected.binary.toString(), "ELF fixture");
    assert.equal(inspected.binaryMember, `${ROOT}/smithers-nanocodex`);
    assert.equal(inspected.packageRoot, ROOT);
  });

  test("accepts the shipped macOS arm64 package root", () => {
    const archive = tar([
      entry(`${DARWIN_ROOT}/`, "5"),
      entry(`${DARWIN_ROOT}/smithers-nanocodex`, "0", "Mach-O fixture", 0o755),
    ]);
    const inspected = inspectReleaseArchive(archive);
    assert.equal(inspected.packageRoot, DARWIN_ROOT);
    assert.equal(inspected.binary.toString(), "Mach-O fixture");
  });

  test("rejects traversal, absolute paths, backslashes, and a second package root", () => {
    for (const path of [`${ROOT}/../escape`, `/tmp/${ROOT}/escape`, `${ROOT}\\escape`, `other-root/file`]) {
      assert.throws(
        () =>
          inspectReleaseArchive(
            tar([
              entry(`${ROOT}/`, "5"),
              entry(path, "0", "bad"),
              entry(`${ROOT}/smithers-nanocodex`, "0", "x", 0o755),
            ]),
          ),
        /unsafe member path|escapes the exact package root/,
      );
    }
  });

  test("rejects symbolic links, hard links, extended headers, and device entries", () => {
    for (const type of ["1", "2", "3", "4", "6", "x", "g", "L", "K"]) {
      assert.throws(
        () => inspectReleaseArchive(tar([entry(`${ROOT}/`, "5"), entry(`${ROOT}/bad`, type)])),
        /forbidden type/,
      );
    }
  });

  test("rejects duplicate paths, file ancestors, missing binaries, and non-executable binaries", () => {
    assert.throws(
      () => inspectReleaseArchive(tar([entry(`${ROOT}/`, "5"), entry(`${ROOT}/`, "5")])),
      /duplicate member/,
    );
    assert.throws(
      () =>
        inspectReleaseArchive(
          tar([
            entry(`${ROOT}/`, "5"),
            entry(`${ROOT}/parent`, "0", "file"),
            entry(`${ROOT}/parent/child`, "0", "child"),
            entry(`${ROOT}/smithers-nanocodex`, "0", "x", 0o755),
          ]),
        ),
      /descends from regular file/,
    );
    assert.throws(() => inspectReleaseArchive(tar([entry(`${ROOT}/`, "5")])), /missing regular executable/);
    assert.throws(
      () => inspectReleaseArchive(tar([entry(`${ROOT}/`, "5"), entry(`${ROOT}/smithers-nanocodex`, "0", "x", 0o644)])),
      /executable regular file/,
    );
  });

  test("checks every tar header checksum before trusting its metadata", () => {
    const archive = tar([entry(`${ROOT}/`, "5"), entry(`${ROOT}/smithers-nanocodex`, "0", "x", 0o755)], {
      corruptHeader: true,
    });
    assert.throws(() => inspectReleaseArchive(archive), /header checksum mismatch/);
  });

  test("requires exact POSIX ustar magic and version fields", () => {
    for (const override of [{ ustarMagic: "ustarX" }, { ustarVersion: "01" }]) {
      assert.throws(
        () =>
          inspectReleaseArchive(
            tar([{ ...entry(`${ROOT}/`, "5"), ...override }, entry(`${ROOT}/smithers-nanocodex`, "0", "x", 0o755)]),
          ),
        /not an exact POSIX ustar entry/,
      );
    }
  });

  test("bounds and digests an archive without inventing source provenance", () => {
    const archive = Buffer.from("archive");
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const artifact = { maximumSizeBytes: archive.length, sha256, sizeBytes: archive.length };
    assert.equal(verifyArchiveIdentity(archive, artifact), sha256);
    assert.throws(() => verifyArchiveIdentity(Buffer.alloc(0), artifact), /1-7 bytes/);
    assert.throws(
      () => verifyArchiveIdentity(archive, { ...artifact, maximumSizeBytes: archive.length - 1 }),
      /1-6 bytes/,
    );
    assert.equal(verifyArchiveIdentity(archive, { ...artifact, sizeBytes: archive.length - 1 }), sha256);
    assert.equal(verifyArchiveIdentity(archive, { ...artifact, sha256: "0".repeat(64) }), sha256);
  });

  test("pins exact version and capability surface", () => {
    assert.doesNotThrow(() => validateRuntimeMetadata("smithers-nanocodex 0.0.2\n", EXPECTED_CAPABILITIES));
    assert.doesNotThrow(() =>
      validateRuntimeMetadata("smithers-nanocodex 0.0.2\n", {
        ...EXPECTED_CAPABILITIES,
        target: "aarch64-apple-darwin",
      }),
    );
    assert.throws(() => validateRuntimeMetadata("smithers-nanocodex 0.0.1", EXPECTED_CAPABILITIES), /version mismatch/);
    assert.throws(
      () => validateRuntimeMetadata("smithers-nanocodex 0.0.2\nextra", EXPECTED_CAPABILITIES),
      /version mismatch/,
    );
    assert.throws(
      () =>
        validateRuntimeMetadata("smithers-nanocodex 0.0.2\n", {
          ...EXPECTED_CAPABILITIES,
          features: { codeMode: false },
        }),
      /fixed v0.0.2 Smithers surface/,
    );
  });

  test("routes exact metadata argv through bounded supervised probes with PATH-only state", async () => {
    const calls = [];
    const capabilitiesOutput = `${JSON.stringify(EXPECTED_CAPABILITIES, null, 2)}\n`;
    const metadata = await probeRuntimeMetadata(
      "/verified/smithers-nanocodex",
      "/scratch/qualification",
      async (options) => {
        calls.push(options);
        return calls.length === 1 ? Buffer.from("smithers-nanocodex 0.0.2\n") : Buffer.from(capabilitiesOutput);
      },
    );

    assert.deepEqual(metadata, {
      capabilities: EXPECTED_CAPABILITIES,
      capabilitiesOutput,
      versionOutput: "smithers-nanocodex 0.0.2\n",
    });
    const expectedEnvironment = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    assert.deepEqual(calls, [
      {
        args: ["--version"],
        binary: "/verified/smithers-nanocodex",
        cwd: "/scratch/qualification",
        env: expectedEnvironment,
        inheritEnv: false,
        maxOutputBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
        timeoutMs: 10_000,
      },
      {
        args: ["capabilities", "--json"],
        binary: "/verified/smithers-nanocodex",
        cwd: "/scratch/qualification",
        env: expectedEnvironment,
        inheritEnv: false,
        maxOutputBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
        timeoutMs: 10_000,
      },
    ]);
    assert.deepEqual(Object.keys(calls[0].env), ["PATH"]);
    assert.doesNotThrow(() => validateRuntimeMetadata(metadata.versionOutput, metadata.capabilities));
  });

  test("execs each fixed bridge metadata command inside the authoritative supervised runner", async () => {
    const binaryBytes = Buffer.from("verified binary fixture");
    await withQualificationScratch(binaryBytes, async ({ binary, scratch }) => {
      for (const [args, expectedOutput] of [
        [["--version"], "smithers-nanocodex 0.0.2\n"],
        [["capabilities", "--json"], `${JSON.stringify(EXPECTED_CAPABILITIES)}\n`],
      ]) {
        let launcherDirectory;
        const output = await runSupervisedMetadataProbe(
          {
            args,
            binary,
            cwd: scratch,
            env: { PATH: "/qualified/path" },
            inheritEnv: false,
            maxOutputBytes: 1024 * 1024,
            maxStderrBytes: 64 * 1024,
            timeoutMs: 10_000,
          },
          async (options) => {
            launcherDirectory = dirname(options.command);
            assert.notEqual(options.command, binary, "the verified binary must never be launched directly");
            assert.deepEqual(options, {
              command: options.command,
              cwd: scratch,
              env: { PATH: "/qualified/path" },
              inheritEnv: false,
              maxOutputBytes: 1024 * 1024,
              maxStderrBytes: 64 * 1024,
              timeoutMs: 10_000,
            });
            const source = await readFile(options.command, "utf8");
            assert.match(source, /^#!\/bin\/sh\n/);
            assert.match(
              source,
              /if \[ "\$#" -ne 2 \] \|\| \[ "\$1" != "capabilities" \] \|\| \[ "\$2" != "--json" \]/,
            );
            assert.equal(source.endsWith(`exec '${binary}' ${args.map((value) => `'${value}'`).join(" ")}\n`), true);
            return Buffer.from(expectedOutput);
          },
        );
        assert.deepEqual(output, Buffer.from(expectedOutput));
        await assert.rejects(access(launcherDirectory), (error) => error.code === "ENOENT");
      }
    });
  });

  test(
    "runs both metadata commands through the real direct-spawn supervisor",
    { skip: process.platform === "win32" },
    async () => {
      const capabilitiesOutput = `${JSON.stringify(EXPECTED_CAPABILITIES)}\n`;
      const fakeBridge = Buffer.from(`#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  printf '%s\\n' 'smithers-nanocodex 0.0.2'
  exit 0
fi
if [ "$#" -eq 2 ] && [ "$1" = "capabilities" ] && [ "$2" = "--json" ]; then
  printf '%s\\n' '${JSON.stringify(EXPECTED_CAPABILITIES)}'
  exit 0
fi
exit 64
`);
      let scratch;
      const metadata = await withQualificationScratch(fakeBridge, async (paths) => {
        scratch = paths.scratch;
        return await probeRuntimeMetadata(paths.binary, paths.scratch);
      });
      assert.deepEqual(metadata, {
        capabilities: EXPECTED_CAPABILITIES,
        capabilitiesOutput,
        versionOutput: "smithers-nanocodex 0.0.2\n",
      });
      assert.doesNotThrow(() => validateRuntimeMetadata(metadata.versionOutput, metadata.capabilities));
      await assert.rejects(access(scratch), (error) => error.code === "ENOENT");
    },
  );

  test("shell-quotes the verified bridge path and removes its launcher after supervised failure", async () => {
    await withQualificationScratch(Buffer.from("fixture"), async ({ scratch }) => {
      const binary = `${scratch}/bridge'with-quote`;
      let launcherDirectory;
      await assert.rejects(
        runSupervisedMetadataProbe(
          {
            args: ["--version"],
            binary,
            cwd: scratch,
            env: { PATH: "/qualified/path" },
            inheritEnv: false,
            maxOutputBytes: 1024,
            maxStderrBytes: 1024,
            timeoutMs: 100,
          },
          async (options) => {
            launcherDirectory = dirname(options.command);
            assert.match(await readFile(options.command, "utf8"), /exec '[^\n]*'\\''with-quote' '--version'\n$/);
            throw new Error("private supervised failure");
          },
        ),
        /private supervised failure/,
      );
      await assert.rejects(access(launcherDirectory), (error) => error.code === "ENOENT");
    });
  });

  test("redacts metadata process failures behind fixed messages", async () => {
    for (const [failedCall, expectedMessage] of [
      [0, "Nanocodex version probe failed."],
      [1, "Nanocodex capabilities probe failed."],
    ]) {
      let call = 0;
      await assert.rejects(
        probeRuntimeMetadata("/verified/smithers-nanocodex", "/scratch/qualification", async () => {
          if (call++ === failedCall) {
            throw Object.assign(new Error("private child-process failure"), { stderr: "private child stderr" });
          }
          return Buffer.from(
            failedCall === 1 && call > 1 ? JSON.stringify(EXPECTED_CAPABILITIES) : "smithers-nanocodex 0.0.2\n",
          );
        }),
        (error) => {
          assert.equal(error.message, expectedMessage);
          assert.equal(error.cause, undefined);
          assert.doesNotMatch(String(error), /private child/);
          return true;
        },
      );
    }

    let call = 0;
    await assert.rejects(
      probeRuntimeMetadata("/verified/smithers-nanocodex", "/scratch/qualification", async () =>
        Buffer.from(call++ === 0 ? "smithers-nanocodex 0.0.2\n" : "private malformed output"),
      ),
      (error) => {
        assert.equal(error.message, "Nanocodex capabilities output is not JSON.");
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(String(error), /private malformed/);
        return true;
      },
    );
  });

  test("removes qualification scratch state after success and metadata failure", async () => {
    const binaryBytes = Buffer.from("verified binary fixture");
    let successfulScratch;
    assert.equal(
      await withQualificationScratch(binaryBytes, async (paths) => {
        successfulScratch = paths.scratch;
        assert.deepEqual(await readFile(paths.binary), binaryBytes);
        if (process.platform !== "win32") assert.notEqual((await stat(paths.binary)).mode & 0o111, 0);
        return "qualified";
      }),
      "qualified",
    );
    await assert.rejects(access(successfulScratch), (error) => error.code === "ENOENT");

    let failedScratch;
    await assert.rejects(
      withQualificationScratch(binaryBytes, async (paths) => {
        failedScratch = paths.scratch;
        assert.deepEqual(await readFile(paths.binary), binaryBytes);
        if (process.platform !== "win32") assert.notEqual((await stat(paths.binary)).mode & 0o111, 0);
        await probeRuntimeMetadata(paths.binary, paths.scratch, async () => {
          throw Object.assign(new Error("private child-process failure"), { stderr: "private child stderr" });
        });
      }),
      (error) => {
        assert.equal(error.message, "Nanocodex version probe failed.");
        assert.doesNotMatch(String(error), /private child/);
        return true;
      },
    );
    await assert.rejects(access(failedScratch), (error) => error.code === "ENOENT");
  });

  test("invokes public adapter preflight after metadata validation and redacts failure while cleaning scratch", async () => {
    const binaryBytes = Buffer.from("exact verified extracted binary");
    const privateFailure = "PRIVATE_ADAPTER_PREFLIGHT_FAILURE";
    const calls = [];
    let failedScratch;

    class FailingPublicNanocodexAgent {
      constructor(options) {
        calls.push({ options, type: "construct" });
      }

      async preflight(options) {
        calls.push({ options, type: "preflight" });
        throw Object.assign(new Error(privateFailure), { stderr: privateFailure });
      }
    }

    await assert.rejects(
      withQualificationScratch(binaryBytes, async ({ binary, scratch }) => {
        failedScratch = scratch;
        await preflightVerifiedBinary(binary, scratch, PINNED_SOURCE_BUILD, {
          NanocodexAgentImpl: FailingPublicNanocodexAgent,
          probeRuntimeMetadataImpl: async (metadataBinary, metadataScratch) => {
            calls.push({ binary: metadataBinary, scratch: metadataScratch, type: "metadata" });
            assert.equal(metadataBinary, binary);
            assert.equal(metadataScratch, scratch);
            assert.deepEqual(await readFile(metadataBinary), binaryBytes);
            return {
              capabilities: EXPECTED_CAPABILITIES,
              versionOutput: "smithers-nanocodex 0.0.2\n",
            };
          },
        });
      }),
      (error) => {
        assert.equal(error.message, "Nanocodex public adapter preflight failed.");
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(String(error), new RegExp(privateFailure));
        return true;
      },
    );

    assert.deepEqual(calls, [
      {
        binary: join(failedScratch, "smithers-nanocodex"),
        scratch: failedScratch,
        type: "metadata",
      },
      {
        options: {
          binary: join(failedScratch, "smithers-nanocodex"),
          cwd: failedScratch,
          env: {},
          inheritEnv: false,
        },
        type: "construct",
      },
      { options: { rootDir: failedScratch }, type: "preflight" },
    ]);
    await assert.rejects(access(failedScratch), (error) => error.code === "ENOENT");
  });

  test("preserves the exact provider-free qualification success JSON", () => {
    const archivePath = resolve("/ci-built/smithers-nanocodex-v0.0.2-x86_64-unknown-linux-gnu.tar.gz");
    const result = qualificationResult({
      archivePath,
      glibcVersion: "2.35",
      manifest: PINNED_SOURCE_BUILD,
      sha256: PINNED_SOURCE_BUILD.artifact.sha256,
      sizeBytes: 6_286_499,
    });
    assert.deepEqual(Object.keys(result), [
      "archive",
      "artifactProvenance",
      "bridgeVersion",
      "glibcVersion",
      "providerFreePreflight",
      "sha256",
      "sizeBytes",
      "sourceCommit",
      "sourceTree",
      "target",
    ]);
    assert.equal(
      JSON.stringify(result, null, 2),
      `{
  "archive": ${JSON.stringify(archivePath)},
  "artifactProvenance": "pinned-source-build-sha256",
  "bridgeVersion": "0.0.2",
  "glibcVersion": "2.35",
  "providerFreePreflight": true,
  "sha256": "3348b8a7818b4c759748e2cf0ecc9e0e4857f33ef6c3a92417655bfc0c73fdff",
  "sizeBytes": 6286499,
  "sourceCommit": "56d8b4fd54bf14e9f2874e5a010b8e301f8f695b",
  "sourceTree": "b8a092569e579c21e2ae288a470a6881022b61f2",
  "target": "x86_64-unknown-linux-gnu"
}`,
    );

    const unverified = qualificationResult({
      archivePath,
      glibcVersion: "2.35",
      manifest: PINNED_SOURCE_BUILD,
      sha256: "0".repeat(64),
      sizeBytes: 123,
    });
    assert.equal(unverified.artifactProvenance, "unverified-input");
    assert.equal(unverified.sourceCommit, null);
    assert.equal(unverified.sourceTree, null);
  });

  test("compares glibc versions numerically", () => {
    assert.equal(compareVersions("2.35", "2.35"), 0);
    assert.equal(compareVersions("2.39", "2.35"), 1);
    assert.equal(compareVersions("2.34.9", "2.35"), -1);
    assert.throws(() => compareVersions("glibc-2.35", "2.35"), /Invalid numeric version/);
  });

  test("accepts Linux x86_64 glibc 2.35+ and macOS arm64 qualification hosts", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
    try {
      Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
      Object.defineProperty(process, "arch", { configurable: true, value: "x64" });
      assert.deepEqual(assertSupportedQualificationHost({ header: { glibcVersionRuntime: "2.35" } }), {
        hostTarget: "x86_64-unknown-linux-gnu",
        glibcVersion: "2.35",
      });
      assert.throws(() => assertSupportedQualificationHost({ header: { glibcVersionRuntime: "2.34" } }), /glibc 2.35/);

      Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
      Object.defineProperty(process, "arch", { configurable: true, value: "arm64" });
      assert.deepEqual(assertSupportedQualificationHost({ header: {} }), {
        hostTarget: "aarch64-apple-darwin",
        glibcVersion: null,
      });

      Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
      Object.defineProperty(process, "arch", { configurable: true, value: "x64" });
      assert.throws(() => assertSupportedQualificationHost(), /Linux x86_64 \(glibc 2.35\+\) or macOS arm64/);
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
      if (originalArch) Object.defineProperty(process, "arch", originalArch);
    }
  });
});

function entry(name, type = "0", contents = "", mode = type === "5" ? 0o755 : 0o644) {
  return { contents: Buffer.from(contents), mode, name, type };
}

function tar(entries, options = {}) {
  const blocks = [];
  for (const item of entries) {
    const header = Buffer.alloc(512);
    writeText(header, 0, 100, item.name);
    writeOctal(header, 100, 8, item.mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, item.contents.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = item.type.charCodeAt(0);
    writeText(header, 257, 6, item.ustarMagic ?? "ustar\0");
    writeText(header, 263, 2, item.ustarVersion ?? "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, item.contents);
    const padding = (512 - (item.contents.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  const raw = Buffer.concat(blocks);
  if (options.corruptHeader) raw[0] ^= 0xff;
  return gzipSync(raw);
}

function writeText(buffer, offset, length, value) {
  const encoded = Buffer.from(value);
  assert.ok(encoded.length <= length, `test tar field ${value} fits`);
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  writeText(buffer, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

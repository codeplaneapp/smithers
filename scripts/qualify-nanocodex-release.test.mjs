import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, test } from "node:test";

import {
  EXPECTED_CAPABILITIES,
  PINNED_RELEASE,
  compareVersions,
  downloadArchive,
  inspectReleaseArchive,
  loadReleaseManifest,
  parseArgs,
  preflightVerifiedBinary,
  probeRuntimeMetadata,
  qualificationResult,
  runContainedMetadataProbe,
  validateRuntimeMetadata,
  verifyArchiveIdentity,
  withQualificationScratch,
} from "./qualify-nanocodex-release.mjs";

const ROOT = "smithers-nanocodex-v0.0.1-x86_64-unknown-linux-gnu";

describe("Nanocodex release qualification", () => {
  test("the checked-in manifest is the immutable exact consumer pin", async () => {
    const manifest = await loadReleaseManifest();
    assert.deepEqual(manifest, PINNED_RELEASE);
    assert.equal(manifest.release.tagCommit, "56d8b4fd54bf14e9f2874e5a010b8e301f8f695b");
    assert.equal(manifest.artifact.maximumSizeBytes, 8 * 1024 * 1024);
    assert.equal(manifest.artifact.minimumGlibcVersion, "2.35");
    assert.equal(manifest.qualification.smithersAdapter, false);
  });

  test("deep-freezes every nested release and capability value", () => {
    assert.equal(Object.isFrozen(PINNED_RELEASE), true);
    assert.equal(Object.isFrozen(EXPECTED_CAPABILITIES), true);
    assert.equal(Object.isFrozen(PINNED_RELEASE.release), true);
    assert.equal(Object.isFrozen(PINNED_RELEASE.qualification.checks), true);
    assert.equal(Object.isFrozen(EXPECTED_CAPABILITIES.protocol.versions), true);
    assert.equal(Object.isFrozen(EXPECTED_CAPABILITIES.features), true);
    assert.throws(() => {
      PINNED_RELEASE.release.version = "tampered";
    }, TypeError);
    assert.throws(() => PINNED_RELEASE.qualification.checks.push("tampered"), TypeError);
    assert.throws(() => {
      EXPECTED_CAPABILITIES.features.codeMode = false;
    }, TypeError);
    assert.throws(() => EXPECTED_CAPABILITIES.authenticationModes.push("tampered"), TypeError);
  });

  test("parses an explicit offline archive and rejects ambiguous CLI arguments", () => {
    assert.equal(parseArgs([]).archivePath, undefined);
    const archivePath = parseArgs(["--archive", "release.tar.gz"]).archivePath;
    assert.equal(isAbsolute(archivePath), true);
    assert.equal(basename(archivePath), "release.tar.gz");
    assert.deepEqual(parseArgs(["--help"]), { help: true });
    assert.throws(() => parseArgs(["--archive"]), /requires a path/);
    assert.throws(() => parseArgs(["--archive", "one.tar.gz", "--archive", "two.tar.gz"]), /only be specified once/);
    assert.throws(() => parseArgs(["--help", "-h"]), /only be specified once/);
    assert.throws(() => parseArgs(["--download"]), /Unknown argument/);
  });

  test("downloads through one approved HTTPS redirect with a bounded manual policy", async () => {
    const archive = Buffer.from("pinned archive");
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/pinned/archive" },
        });
      }
      return new Response(archive, { status: 200, headers: { "content-length": String(archive.length) } });
    };

    const result = await downloadArchive(PINNED_RELEASE.artifact.downloadUrl, archive.length, fetchImpl);
    assert.deepEqual(result, archive);
    assert.equal(calls.length, 2);
    assert.equal(
      calls.every(({ options }) => options.redirect === "manual" && options.signal instanceof AbortSignal),
      true,
    );
  });

  test("rejects unsafe or excessive redirects", async () => {
    await assert.rejects(
      downloadArchive("https://github.com/other/repository/releases/download/v0.0.1/archive.tar.gz", 1, async () => {
        throw new Error("must not connect");
      }),
      /immutable v0\.0\.1 URL/,
    );
    for (const [location, error] of [
      ["https://example.com/archive", /redirect host is not allowed/],
      ["http://release-assets.githubusercontent.com/archive", /must use HTTPS/],
      ["https://release-assets.githubusercontent.com:444/archive", /custom port/],
    ]) {
      await assert.rejects(
        downloadArchive(
          PINNED_RELEASE.artifact.downloadUrl,
          1,
          async () => new Response(null, { status: 302, headers: { location } }),
        ),
        error,
      );
    }
    await assert.rejects(
      downloadArchive(
        PINNED_RELEASE.artifact.downloadUrl,
        1,
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://release-assets.githubusercontent.com/redirect-loop" },
          }),
        { maxRedirects: 1 },
      ),
      /exceeded 1 redirects/,
    );
  });

  test("bounds stalled connections and downloads with one overall deadline", async () => {
    const stalledFetch = (_url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    await assert.rejects(
      downloadArchive(PINNED_RELEASE.artifact.downloadUrl, 1, stalledFetch, { timeoutMs: 10 }),
      /timed out after 10ms/,
    );

    const stalledBodyFetch = async (_url, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.of(0));
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        }),
        { status: 200 },
      );
    await assert.rejects(
      downloadArchive(PINNED_RELEASE.artifact.downloadUrl, 2, stalledBodyFetch, { timeoutMs: 10 }),
      /timed out after 10ms/,
    );
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

  test("bounds a CI-built archive and reports its SHA-256", () => {
    const archive = Buffer.from("archive");
    const sha256 = createHash("sha256").update(archive).digest("hex");
    assert.equal(verifyArchiveIdentity(archive, { maximumSizeBytes: archive.length }), sha256);
    assert.throws(() => verifyArchiveIdentity(Buffer.alloc(0), { maximumSizeBytes: archive.length }), /1-7 bytes/);
    assert.throws(() => verifyArchiveIdentity(archive, { maximumSizeBytes: archive.length - 1 }), /1-6 bytes/);
  });

  test("pins exact version and capability surface", () => {
    assert.doesNotThrow(() => validateRuntimeMetadata("smithers-nanocodex 0.0.1\n", EXPECTED_CAPABILITIES));
    assert.throws(() => validateRuntimeMetadata("smithers-nanocodex 0.0.2", EXPECTED_CAPABILITIES), /version mismatch/);
    assert.throws(
      () => validateRuntimeMetadata("smithers-nanocodex 0.0.1\nextra", EXPECTED_CAPABILITIES),
      /version mismatch/,
    );
    assert.throws(
      () =>
        validateRuntimeMetadata("smithers-nanocodex 0.0.1\n", {
          ...EXPECTED_CAPABILITIES,
          features: { codeMode: false },
        }),
      /fixed v0.0.1 Smithers surface/,
    );
  });

  test("routes exact metadata argv through bounded contained probes with PATH-only state", async () => {
    const calls = [];
    const capabilitiesOutput = `${JSON.stringify(EXPECTED_CAPABILITIES, null, 2)}\n`;
    const metadata = await probeRuntimeMetadata(
      "/verified/smithers-nanocodex",
      "/scratch/qualification",
      async (options) => {
        calls.push(options);
        return calls.length === 1 ? Buffer.from("smithers-nanocodex 0.0.1\n") : Buffer.from(capabilitiesOutput);
      },
    );

    assert.deepEqual(metadata, {
      capabilities: EXPECTED_CAPABILITIES,
      capabilitiesOutput,
      versionOutput: "smithers-nanocodex 0.0.1\n",
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
        [["--version"], "smithers-nanocodex 0.0.1\n"],
        [["capabilities", "--json"], `${JSON.stringify(EXPECTED_CAPABILITIES)}\n`],
      ]) {
        let launcherDirectory;
        const output = await runContainedMetadataProbe(
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

  test("runs both metadata commands through the real Bubblewrap supervisor", async (context) => {
    if (process.platform !== "linux") return context.skip("Nanocodex containment is Linux-only.");
    try {
      await access("/usr/bin/bwrap");
    } catch {
      try {
        await access("/bin/bwrap");
      } catch {
        return context.skip("Bubblewrap is not installed.");
      }
    }

    const capabilitiesOutput = `${JSON.stringify(EXPECTED_CAPABILITIES)}\n`;
    const fakeBridge = Buffer.from(`#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  printf '%s\\n' 'smithers-nanocodex 0.0.1'
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
      versionOutput: "smithers-nanocodex 0.0.1\n",
    });
    assert.doesNotThrow(() => validateRuntimeMetadata(metadata.versionOutput, metadata.capabilities));
    await assert.rejects(access(scratch), (error) => error.code === "ENOENT");
  });

  test("shell-quotes the contained bridge path and removes its launcher after supervised failure", async () => {
    await withQualificationScratch(Buffer.from("fixture"), async ({ scratch }) => {
      const binary = `${scratch}/bridge'with-quote`;
      let launcherDirectory;
      await assert.rejects(
        runContainedMetadataProbe(
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
            failedCall === 1 && call > 1 ? JSON.stringify(EXPECTED_CAPABILITIES) : "smithers-nanocodex 0.0.1\n",
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
        Buffer.from(call++ === 0 ? "smithers-nanocodex 0.0.1\n" : "private malformed output"),
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
        await preflightVerifiedBinary(binary, scratch, PINNED_RELEASE, {
          NanocodexAgentImpl: FailingPublicNanocodexAgent,
          probeRuntimeMetadataImpl: async (metadataBinary, metadataScratch) => {
            calls.push({ binary: metadataBinary, scratch: metadataScratch, type: "metadata" });
            assert.equal(metadataBinary, binary);
            assert.equal(metadataScratch, scratch);
            assert.deepEqual(await readFile(metadataBinary), binaryBytes);
            return {
              capabilities: EXPECTED_CAPABILITIES,
              versionOutput: "smithers-nanocodex 0.0.1\n",
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
    const result = qualificationResult({
      archivePath: undefined,
      glibcVersion: "2.35",
      manifest: PINNED_RELEASE,
      sha256: "a".repeat(64),
      sizeBytes: 6_286_335,
    });
    assert.deepEqual(Object.keys(result), [
      "archive",
      "bridgeVersion",
      "glibcVersion",
      "providerFreePreflight",
      "sha256",
      "sizeBytes",
      "tag",
      "tagCommit",
      "tagCommitProvenance",
      "target",
    ]);
    assert.equal(
      JSON.stringify(result, null, 2),
      `{
  "archive": "https://github.com/N0xMare/smithers-nanocodex/releases/download/v0.0.1/smithers-nanocodex-v0.0.1-x86_64-unknown-linux-gnu.tar.gz",
  "bridgeVersion": "0.0.1",
  "glibcVersion": "2.35",
  "providerFreePreflight": true,
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sizeBytes": 6286335,
  "tag": "v0.0.1",
  "tagCommit": "56d8b4fd54bf14e9f2874e5a010b8e301f8f695b",
  "tagCommitProvenance": "asserted-pinned-manifest",
  "target": "x86_64-unknown-linux-gnu"
}`,
    );
  });

  test("compares glibc versions numerically", () => {
    assert.equal(compareVersions("2.35", "2.35"), 0);
    assert.equal(compareVersions("2.39", "2.35"), 1);
    assert.equal(compareVersions("2.34.9", "2.35"), -1);
    assert.throws(() => compareVersions("glibc-2.35", "2.35"), /Invalid numeric version/);
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

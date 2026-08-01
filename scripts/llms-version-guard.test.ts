import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersionRelease, createVersionedArtifactGuard } from "./llms-version-guard.ts";
import { versionedGeneratorArgs } from "./llms-check-mode.mjs";

const VERSION = "0.28.0";

function withFixture(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "smithers-llms-version-guard-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("versioned llms artifact guard", () => {
  test("treats a release tag as immutable without consulting npm", () => {
    let publicationChecks = 0;
    expect(
      checkVersionRelease(VERSION, {
        hasReleaseTag: () => true,
        checkPublication: () => {
          publicationChecks += 1;
          return "unpublished";
        },
      }),
    ).toBe("published");
    expect(publicationChecks).toBe(0);
  });

  test("check mode skips versioned bundles only for a confirmed published version", () => {
    expect(versionedGeneratorArgs("published", VERSION)).toEqual(["--skip-versioned"]);
    expect(versionedGeneratorArgs("unpublished", VERSION)).toEqual([]);
    expect(() => versionedGeneratorArgs("unavailable", VERSION)).toThrow(/refusing to skip versioned/);
  });

  test("skips versioned artifacts without consulting npm when requested", () => {
    withFixture((dir) => {
      const path = join(dir, "llms-full-v0.28.0.txt");
      writeFileSync(path, "historic bundle\n");
      let checks = 0;
      const guard = createVersionedArtifactGuard(VERSION, {
        skipVersioned: true,
        checkPublication: () => {
          checks += 1;
          return "published";
        },
      });

      expect(guard.write(path, "new bundle\n")).toBe("skipped");
      expect(checks).toBe(0);
      expect(readFileSync(path, "utf8")).toBe("historic bundle\n");
      expect(() => guard.assertNoPublishedVersion()).not.toThrow();
    });
  });

  test("refuses to overwrite a version already published on npm", () => {
    withFixture((dir) => {
      const path = join(dir, "llms-full-v0.28.0.txt");
      writeFileSync(path, "historic bundle\n");
      const errors: string[] = [];
      const guard = createVersionedArtifactGuard(VERSION, {
        checkPublication: () => "published",
        error: (message) => errors.push(message),
      });

      expect(guard.write(path, "new bundle\n")).toBe("refused");
      expect(readFileSync(path, "utf8")).toBe("historic bundle\n");
      expect(errors[0]).toContain("Bump the package version first");
      expect(() => guard.assertNoPublishedVersion()).toThrow(/already released/);
    });
  });

  test("writes a versioned artifact when the package version is unpublished", () => {
    withFixture((dir) => {
      const path = join(dir, "llms-v0.28.0.txt");
      const checkedVersions: string[] = [];
      const guard = createVersionedArtifactGuard(VERSION, {
        checkPublication: (version) => {
          checkedVersions.push(version);
          return "unpublished";
        },
      });

      expect(guard.write(path, "release candidate\n")).toBe("written");
      expect(readFileSync(path, "utf8")).toBe("release candidate\n");
      expect(checkedVersions).toEqual([VERSION]);
      guard.assertNoPublishedVersion();
    });
  });

  test("skips the versioned artifact and warns when the registry is unreachable", () => {
    withFixture((dir) => {
      const path = join(dir, "llms-full-v0.28.0.txt");
      const warnings: string[] = [];
      const guard = createVersionedArtifactGuard(VERSION, {
        checkPublication: () => "unavailable",
        warn: (message) => warnings.push(message),
      });

      expect(guard.write(path, "unchecked bundle\n")).toBe("skipped");
      expect(existsSync(path)).toBe(false);
      expect(warnings[0]).toMatch(/npm registry status .* unavailable/);
      expect(warnings[0]).toContain(path);
      guard.assertNoPublishedVersion();
    });
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVersionedArtifactGuard } from "./llms-version-guard.ts";

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
      expect(() => guard.assertNoPublishedVersion()).toThrow(/already published on npm/);
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

import { describe, expect, it, afterEach } from "bun:test";
import { join } from "node:path";
import { resolveManifestPath } from "./generateSlideshow.ts";

describe("resolveManifestPath", () => {
  const originalEnv = process.env.SMITHERS_CAPTURE_DRY_RUN;
  // A directory that does not exist on disk, so the newer-dry-run probe
  // (existsSync) never fires and the default branch stays deterministic.
  const baseDir = "/tmp/smithers-slideshow-test-fixture";

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SMITHERS_CAPTURE_DRY_RUN;
    } else {
      process.env.SMITHERS_CAPTURE_DRY_RUN = originalEnv;
    }
  });

  it("returns explicit path when provided", () => {
    expect(resolveManifestPath("/custom/path.json")).toBe("/custom/path.json");
  });

  it("returns dry-run manifest when preferDryRun option is set", () => {
    delete process.env.SMITHERS_CAPTURE_DRY_RUN;
    expect(resolveManifestPath(undefined, { baseDir, preferDryRun: true })).toBe(
      join(baseDir, "manifest.dry-run.json"),
    );
  });

  it("returns dry-run manifest when SMITHERS_CAPTURE_DRY_RUN is set", () => {
    process.env.SMITHERS_CAPTURE_DRY_RUN = "1";
    expect(resolveManifestPath(undefined, { baseDir })).toBe(join(baseDir, "manifest.dry-run.json"));
  });

  it("returns live manifest by default", () => {
    delete process.env.SMITHERS_CAPTURE_DRY_RUN;
    expect(resolveManifestPath(undefined, { baseDir })).toBe(join(baseDir, "manifest.json"));
  });
});

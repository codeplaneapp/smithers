import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveManifestPath } from "./generateSlideshow.ts";

describe("resolveManifestPath", () => {
  const originalEnv = process.env.SMITHERS_CAPTURE_DRY_RUN;
  // A real but EMPTY temp dir: the newer-dry-run probe (existsSync) can never
  // fire because no manifest files exist, so the default branch stays
  // deterministic no matter what's already sitting in the machine's /tmp.
  let baseDir = "";

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), "smithers-slideshow-"));
  });

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

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

#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const PUBLISHED_PACKAGE_NAME = "smithers-orchestrator";

export type NpmPublicationStatus = "published" | "unpublished" | "unavailable";
export type NpmPublicationChecker = (version: string) => NpmPublicationStatus;
export type VersionedArtifactWriteResult = "written" | "refused" | "skipped";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * Check whether an exact package version is present on npm.
 *
 * npm uses the same non-zero exit status for a missing version and a registry
 * failure, so only the documented not-found responses are treated as an
 * unpublished version. Everything else is unavailable and must not make a
 * docs build fail.
 */
export function checkNpmPublication(version: string): NpmPublicationStatus {
  const result = spawnSync("npm", ["view", `${PUBLISHED_PACKAGE_NAME}@${version}`, "version"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status === 0) return "published";

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/\bE404\b|404\s+(?:Not Found|No match)|No match found for version/i.test(output)) {
    return "unpublished";
  }
  return "unavailable";
}

type VersionedArtifactGuardOptions = {
  checkPublication?: NpmPublicationChecker;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  skipVersioned?: boolean;
};

/**
 * Create a writer for version-pinned docs artifacts.
 *
 * The publication check is lazy so ordinary unversioned docs generation can
 * finish before a registry lookup is needed. The check is cached for the
 * whole generation run, keeping both versioned files on one decision.
 */
export function createVersionedArtifactGuard(
  version: string,
  options: VersionedArtifactGuardOptions = {},
) {
  const checkPublication = options.checkPublication ?? checkNpmPublication;
  const warn = options.warn ?? console.warn;
  const error = options.error ?? console.error;
  const skipVersioned = options.skipVersioned ?? false;
  let status: NpmPublicationStatus | undefined;
  const refusedPaths: string[] = [];

  function publicationStatus(): NpmPublicationStatus {
    if (status) return status;
    try {
      status = checkPublication(version);
    } catch (cause) {
      status = "unavailable";
      const detail = cause instanceof Error ? `: ${cause.message}` : "";
      warn(
        `Warning: could not check npm for ${PUBLISHED_PACKAGE_NAME}@${version}${detail}; ` +
          "skipping versioned docs artifacts.",
      );
    }
    return status;
  }

  function write(path: string, content: string): VersionedArtifactWriteResult {
    if (skipVersioned) return "skipped";
    const currentStatus = publicationStatus();
    if (currentStatus === "published") {
      const message =
        `Refusing to overwrite ${path}: ${PUBLISHED_PACKAGE_NAME}@${version} is already ` +
        "published on npm. Bump the package version first before regenerating versioned docs.";
      if (refusedPaths.length === 0) error(message);
      refusedPaths.push(path);
      return "refused";
    }
    if (currentStatus === "unavailable") {
      warn(
        `Warning: npm registry status for ${PUBLISHED_PACKAGE_NAME}@${version} is unavailable; ` +
          `skipping versioned docs artifact ${path}.`,
      );
      return "skipped";
    }
    writeFileSync(path, content);
    return "written";
  }

  function assertNoPublishedVersion(): void {
    if (refusedPaths.length === 0) return;
    throw new Error(
      `Refused to modify versioned docs for ${PUBLISHED_PACKAGE_NAME}@${version} because ` +
        "that version is already published on npm. " +
        "Bump the package version first, then regenerate the docs bundles.",
    );
  }

  return { write, assertNoPublishedVersion };
}

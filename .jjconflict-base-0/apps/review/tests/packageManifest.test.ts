import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * What `apps/review/package.json` is allowed to promise.
 *
 * The release policy fixes the published set at rc.0 and closes it with
 * rule (d), "nothing else". `@smthrs/review` is in neither the section 3.1
 * roster nor the section 3.2 private list, and `scripts/pack-release.mjs`
 * reads `packages/` alone, so no release path can ever pack an app. A
 * non-private app manifest therefore advertises an `npm install` that cannot
 * exist, and `scripts/set-release-version.mjs --check` holds it to the release
 * version forever.
 *
 * The ranges are the same contract read from the other side. rule (d) names
 * this manifest explicitly: "apps/review links @smthrs/ui-styleguide through
 * workspace:*". A private workspace package keeps its own version
 * (docs/pages/package-structure.mdx), so an exact range naming one resolves
 * only while `linkWorkspacePackages: true` and the two versions coincide.
 *
 * Both rules are read off the workspace rather than restated here, so a
 * package flipping `private` moves the expectation instead of the test.
 */
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Every workspace manifest under `directory`, keyed by directory name. */
function manifestsUnder(directory: string): Map<string, Manifest> {
  const found = new Map<string, Manifest>();
  for (const entry of readdirSync(`${workspaceRoot}${directory}`, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = `${workspaceRoot}${directory}/${entry.name}/package.json`;
    try {
      found.set(entry.name, JSON.parse(readFileSync(manifestPath, "utf8")));
    } catch {
      continue; // Not a package directory.
    }
  }
  return found;
}

describe("apps/review promises only what the release policy can deliver", () => {
  test("no app is publishable, so every manifest under apps/ declares private", () => {
    // pack-release.mjs walks `packages/` and refuses any name outside the
    // section 3.1 roster. An app is unreachable from that walk by construction,
    // so `private` is the only honest declaration one can carry.
    const publishable = [...manifestsUnder("apps")]
      .filter(([, manifest]) => manifest.private !== true)
      .map(([directory, manifest]) => `apps/${directory} (${manifest.name})`);
    expect(publishable).toEqual([]);
  });

  test("every workspace range names a private package through workspace: or a public one at its version", () => {
    const workspaceManifests = new Map<string, Manifest>();
    for (const directory of ["apps", "packages"]) {
      for (const manifest of manifestsUnder(directory).values()) {
        if (manifest.name) workspaceManifests.set(manifest.name, manifest);
      }
    }
    const review = workspaceManifests.get("@smthrs/review");
    expect(review).toBeDefined();

    const wrong: string[] = [];
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      for (const [name, range] of Object.entries(review?.[field] ?? {})) {
        const target = workspaceManifests.get(name);
        if (target === undefined) continue; // A registry dependency.
        if (target.private === true) {
          if (!range.startsWith("workspace:")) {
            wrong.push(`${field}.${name} is ${range}; ${name} is private, so the range must be workspace:*`);
          }
        } else if (range !== target.version) {
          wrong.push(`${field}.${name} is ${range}; ${name} is published at ${target.version}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  computeNextVersion,
  parseNextEpoch,
  propagateVersion,
  shouldAdvanceNext,
  syncGatewayClientVersion,
  workspacePackages,
} from "./publish-next.mjs";

/** Build a throwaway workspace with a root, two public packages, and a private app. */
function makeFixtureWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "publish-next-"));
  const writePkg = (rel, pkg) => {
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-root", private: true, version: "0.28.0" }, null, 2) + "\n");
  writePkg("packages/alpha", { name: "@fixture/alpha", version: "0.28.0", dependencies: { "@fixture/beta": "workspace:*" } });
  writePkg("packages/beta", { name: "@fixture/beta", version: "0.28.0" });
  writePkg("apps/secret", { name: "@fixture/secret", private: true, version: "0.28.0" });
  return dir;
}

describe("computeNextVersion", () => {
  test("formats base-next.epoch.gsha", () => {
    expect(computeNextVersion("0.28.0", 1752480000, "0932f089ef11")).toBe("0.28.0-next.1752480000.g0932f089ef11");
  });

  test("g prefix keeps an all-digit leading-zero sha a valid semver identifier", () => {
    const version = computeNextVersion("0.28.0", 1752480000, "012345678901");
    expect(version).toBe("0.28.0-next.1752480000.g012345678901");
    // Every dot-separated prerelease identifier must be numeric-without-leading-zero
    // or alphanumeric; g<sha> is always alphanumeric.
    const prerelease = version.split("-")[1];
    for (const id of prerelease.split(".")) {
      expect(/^(0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)$/.test(id)).toBe(true);
    }
  });

  test("refuses a prerelease base version", () => {
    expect(() => computeNextVersion("0.28.0-rc.1", 1752480000, "abcdef")).toThrow(/already a prerelease/);
  });

  test("refuses a bogus epoch or sha", () => {
    expect(() => computeNextVersion("0.28.0", 0, "abcdef")).toThrow(/epoch/);
    expect(() => computeNextVersion("0.28.0", 1.5, "abcdef")).toThrow(/epoch/);
    expect(() => computeNextVersion("0.28.0", 1752480000, "not-a-sha")).toThrow(/sha/);
  });
});

describe("parseNextEpoch", () => {
  test("round-trips the epoch out of a next version", () => {
    expect(parseNextEpoch(computeNextVersion("0.28.0", 1752480000, "abcd1234"))).toBe(1752480000);
  });

  test("returns null for non-next versions", () => {
    expect(parseNextEpoch("0.27.0")).toBeNull();
    expect(parseNextEpoch("0.28.0-rc.1")).toBeNull();
  });
});

describe("shouldAdvanceNext", () => {
  test("advances when no next tag exists yet", () => {
    expect(shouldAdvanceNext(null, 1752480000)).toBe(true);
    expect(shouldAdvanceNext(undefined, 1752480000)).toBe(true);
    expect(shouldAdvanceNext("", 1752480000)).toBe(true);
  });

  test("advances over an older or equal snapshot", () => {
    expect(shouldAdvanceNext("0.28.0-next.1752470000.gaaaa1111", 1752480000)).toBe(true);
    expect(shouldAdvanceNext("0.28.0-next.1752480000.gaaaa1111", 1752480000)).toBe(true);
  });

  test("does not advance over a newer commit's snapshot", () => {
    expect(shouldAdvanceNext("0.28.0-next.1752490000.gaaaa1111", 1752480000)).toBe(false);
  });

  test("advances over a non-next version parked on the tag", () => {
    expect(shouldAdvanceNext("0.27.0", 1752480000)).toBe(true);
  });
});

describe("workspacePackages / propagateVersion", () => {
  test("rewrites root and public packages, skips private ones, keeps workspace protocol deps", () => {
    const dir = makeFixtureWorkspace();
    try {
      expect(workspacePackages(dir).map((pkg) => pkg.name)).toEqual(["@fixture/alpha", "@fixture/beta"]);

      const version = "0.28.0-next.1752480000.gabcd12345678";
      const changed = propagateVersion(dir, version);
      expect(changed.length).toBe(3);

      const readPkg = (rel) => JSON.parse(readFileSync(join(dir, rel, "package.json"), "utf8"));
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe(version);
      expect(readPkg("packages/alpha").version).toBe(version);
      expect(readPkg("packages/beta").version).toBe(version);
      expect(readPkg("apps/secret").version).toBe("0.28.0");
      // pnpm substitutes the concrete version at pack time — the manifest keeps the protocol.
      expect(readPkg("packages/alpha").dependencies["@fixture/beta"]).toBe("workspace:*");
      // Idempotent: a second run changes nothing.
      expect(propagateVersion(dir, version)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("syncGatewayClientVersion", () => {
  test("rewrites the DEFAULT_CLIENT_VERSION pin", () => {
    const dir = makeFixtureWorkspace();
    try {
      const clientDir = join(dir, "packages", "gateway-client", "src");
      mkdirSync(clientDir, { recursive: true });
      const clientPath = join(clientDir, "SmithersGatewayClient.ts");
      writeFileSync(clientPath, 'const DEFAULT_CLIENT_VERSION = "0.28.0";\n');
      syncGatewayClientVersion(dir, "0.28.0-next.1752480000.gabcd12345678");
      expect(readFileSync(clientPath, "utf8")).toBe('const DEFAULT_CLIENT_VERSION = "0.28.0-next.1752480000.gabcd12345678";\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when the pin pattern is gone", () => {
    const dir = makeFixtureWorkspace();
    try {
      const clientDir = join(dir, "packages", "gateway-client", "src");
      mkdirSync(clientDir, { recursive: true });
      writeFileSync(join(clientDir, "SmithersGatewayClient.ts"), "export {};\n");
      expect(() => syncGatewayClientVersion(dir, "0.29.0-next.1.gabcd")).toThrow(/DEFAULT_CLIENT_VERSION/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the real gateway-client source still carries the pin the release scripts rewrite", () => {
    const repoRoot = join(import.meta.dirname, "..");
    const source = readFileSync(join(repoRoot, "packages", "gateway-client", "src", "SmithersGatewayClient.ts"), "utf8");
    expect(/const DEFAULT_CLIENT_VERSION = "[^"]+"/.test(source)).toBe(true);
  });
});

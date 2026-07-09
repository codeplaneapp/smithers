import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { scanDirectDbAccess } from "./check-no-direct-db-access.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

const expectedBaseline = new Map([
  ["packages/engine/src/effect/builder.js", 3],
  ["packages/smithers/src/openSmithersStore.js", 4],
  ["packages/smithers/src/migrateSmithersStore.js", 7],
  ["packages/smithers/src/resolveSmithersBackendChoice.js", 3],
  ["packages/smithers/src/create.js", 3],
  ["packages/smithers/src/external/create-external-smithers.js", 1],
  ["apps/cli/src/index.js", 1],
]);

/** @param {(root: string) => void} fn */
function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "smithers-db-access-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** @param {string} root @param {string} file @param {string} contents */
function writeFixture(root, file, contents) {
  const absFile = join(root, ...file.split("/"));
  mkdirSync(dirname(absFile), { recursive: true });
  writeFileSync(absFile, contents);
}

function sortedEntries(map) {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

describe("scanDirectDbAccess", () => {
  test("reports untracked direct Database calls in package sources", () => {
    withTempRoot((root) => {
      writeFixture(
        root,
        "packages/fixture-pkg/src/index.js",
        'import { Database } from "bun:sqlite";\nconst sqlite = new Database(":memory:");\n',
      );

      expect(sortedEntries(scanDirectDbAccess(root))).toEqual([
        ["packages/fixture-pkg/src/index.js", 1],
      ]);
    });
  });

  test("does not report sanctioned storage-layer source roots", () => {
    withTempRoot((root) => {
      writeFixture(
        root,
        "packages/db/src/index.js",
        'import { Database } from "bun:sqlite";\nconst sqlite = new Database(":memory:");\n',
      );

      expect(sortedEntries(scanDirectDbAccess(root))).toEqual([]);
    });
  });

  test("matches the current repository direct DB access baseline exactly", () => {
    expect(sortedEntries(scanDirectDbAccess(repoRoot))).toEqual(sortedEntries(expectedBaseline));
  });
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
const migrateTestFiles = [
  "packages/smithers/tests/migrateSmithersStore.test.js",
  "packages/smithers/tests/migrateSmithersStoreReverse.test.js",
  "packages/smithers/tests/migrateSmithersStoreReceipts.test.js",
  "packages/smithers/tests/migrateSmithersStorePostgres.test.js",
];

test("test-postgres isolates every migrate-store test in its own bun process", () => {
  const configuredChunks = Number(
    workflow.match(/SMITHERS_MIGRATE_CHUNKS=(\d+)/)?.[1],
  );

  expect(configuredChunks).toBeGreaterThan(0);
  expect(workflow).toContain(`for chunk in {0..${configuredChunks - 1}}; do`);
  expect(workflow).toContain('SMITHERS_MIGRATE_CHUNK="$chunk" bun test "$test_file"');

  for (const relativePath of migrateTestFiles) {
    expect(workflow).toContain(relativePath);
    const source = readFileSync(resolve(repoRoot, relativePath), "utf8");
    const chunkedTestCount = source.match(/\bchunkedTest\s*\(/g)?.length ?? 0;
    expect(chunkedTestCount).toBeGreaterThan(0);
    expect(chunkedTestCount).toBeLessThanOrEqual(configuredChunks);
  }
});

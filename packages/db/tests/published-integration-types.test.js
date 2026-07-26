import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pkgDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(pkgDir, "..", "..");
const tsc = join(repoRoot, "node_modules", ".bin", "tsc");

describe("published integration delivery claim types", () => {
  const tmp = mkdtempSync(join(tmpdir(), "db-integration-types-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  symlinkSync(join(repoRoot, "node_modules"), join(tmp, "node_modules"), "dir");
  writeFileSync(
    join(tmp, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["consumer.ts"],
    }),
  );

  test("a published consumer can import the claim union and call every lifecycle method", () => {
    writeFileSync(
      join(tmp, "consumer.ts"),
      [
        `import type { IntegrationDeliveryClaim, SmithersDb } from "@smithers-orchestrator/db/adapter";`,
        `declare const db: SmithersDb;`,
        `const row = { sourceId: "telegram", dedupeKey: "update:1", eventName: "integration:telegram:message", receivedAtMs: 1 };`,
        `async function lifecycle(): Promise<IntegrationDeliveryClaim> {`,
        `  const claim: IntegrationDeliveryClaim = await db.claimIntegrationDelivery(row, { ownerToken: "worker", nowMs: 2, leaseDurationMs: 1000 });`,
        `  const renewed: boolean = await db.renewIntegrationDeliveryClaim(row.sourceId, row.dedupeKey, "worker", 3, 1000);`,
        `  const completed: boolean = await db.completeIntegrationDelivery(row.sourceId, row.dedupeKey, "worker", 4);`,
        `  const released: boolean = await db.releaseIntegrationDeliveryClaim(row.sourceId, row.dedupeKey, "worker");`,
        `  void [renewed, completed, released];`,
        `  return claim;`,
        `}`,
        `export { lifecycle };`,
      ].join("\n"),
    );
    const result = spawnSync(tsc, ["-p", "tsconfig.json"], { cwd: tmp, encoding: "utf8" });
    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.status).toBe(0);
  }, 30_000);
});

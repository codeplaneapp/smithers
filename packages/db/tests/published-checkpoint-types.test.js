import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pkgDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(pkgDir, "..", "..");
const tsc = join(repoRoot, "node_modules", ".bin", "tsc");

describe("published agent checkpoint table types", () => {
  const tmp = mkdtempSync(join(tmpdir(), "db-checkpoint-types-"));
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

  test("a published consumer sees concrete columns, inferred rows, and nullability", () => {
    writeFileSync(
      join(tmp, "consumer.ts"),
      [
        `import { smithersAgentCheckpointContents, smithersAgentCheckpoints } from "@smthrs/db";`,
        `type Content = typeof smithersAgentCheckpointContents.$inferSelect;`,
        `type Ref = typeof smithersAgentCheckpoints.$inferSelect;`,
        `const content: Content = { contentHash: "hash", checkpointJson: "{}", sizeBytes: 2, createdAtMs: 1 };`,
        `const ref: Ref = { runId: "run", nodeId: "node", iteration: 0, attempt: 1, sequence: 0, contentHash: content.contentHash, codec: "json", version: 1, agentId: null, purpose: "resume", createdAtMs: 1 };`,
        `const nullableAgentId: string | null = ref.agentId;`,
        `const hashColumnName: string = smithersAgentCheckpointContents.contentHash.name;`,
        `// @ts-expect-error content hashes are required`,
        `const invalidContent: Content = { ...content, contentHash: null };`,
        `// @ts-expect-error nonexistent columns must not be accepted through any`,
        `smithersAgentCheckpoints.nonexistent;`,
        `void [nullableAgentId, hashColumnName, invalidContent];`,
      ].join("\n"),
    );
    const result = spawnSync(tsc, ["-p", "tsconfig.json"], { cwd: tmp, encoding: "utf8" });
    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.status).toBe(0);
  }, 30_000);
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTopStore } from "../src/smithers-top.js";

describe("openTopStore read path never scaffolds", () => {
  test("fails fast from empty dir and does not create smithers.db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-no-create-"));
    try {
      const dbPath = join(dir, "smithers.db");
      expect(existsSync(dbPath)).toBe(false);
      let err;
      try {
        await openTopStore({ cwd: dir });
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err?.code).toBe("CLI_DB_NOT_FOUND");
      expect(existsSync(dbPath)).toBe(false);
      // No stray files under the empty dir
      expect(existsSync(join(dir, ".smithers"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

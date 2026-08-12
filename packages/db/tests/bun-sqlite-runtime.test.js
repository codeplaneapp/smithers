import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadBunSqliteDatabase, loadBunSqliteDrizzle } from "../src/bunSqliteRuntime.js";

const moduleUrl = new URL("../src/bunSqliteRuntime.js", import.meta.url).href;

/**
 * Run a snippet under plain Node. The point of this module is what happens off
 * Bun, so the Node half of the cross-product has to be exercised in a real Node
 * process rather than simulated.
 *
 * @param {string} source
 */
function runUnderNode(source) {
  return execFileSync(
    process.execPath.includes("bun") ? "node" : process.execPath,
    ["--input-type=module", "-e", source],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

describe("bunSqliteRuntime under Bun", () => {
  test("loadBunSqliteDatabase opens an in-memory database", () => {
    const Database = loadBunSqliteDatabase();
    const sqlite = new Database(":memory:");
    sqlite.run("CREATE TABLE t (a TEXT)");
    sqlite.close();
  });

  test("loadBunSqliteDrizzle returns the drizzle factory", () => {
    expect(typeof loadBunSqliteDrizzle()).toBe("function");
  });
});

describe("bunSqliteRuntime under Node", () => {
  test("importing the module does not touch bun:sqlite", () => {
    const output = runUnderNode(`await import(${JSON.stringify(moduleUrl)}); console.log("imported");`);
    expect(output.trim()).toBe("imported");
  });

  test("requesting sqlite reports DB_REQUIRES_BUN_SQLITE with the pglite fix", () => {
    const output = runUnderNode(`
      const m = await import(${JSON.stringify(moduleUrl)});
      for (const load of [m.loadBunSqliteDatabase, m.loadBunSqliteDrizzle]) {
        try {
          load();
          console.log("NO_THROW");
        } catch (error) {
          console.log(JSON.stringify({ code: error.code, message: error.message }));
        }
      }
    `);
    const thrown = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(thrown).toHaveLength(2);
    for (const error of thrown) {
      expect(error.code).toBe("DB_REQUIRES_BUN_SQLITE");
      expect(error.message).toContain("requires Bun");
      expect(error.message).toContain("SMITHERS_BACKEND=pglite");
    }
  });

  test("openDurableSqliteDatabase reports the same error rather than a loader crash", () => {
    const url = new URL("../src/openDurableSqliteDatabase.js", import.meta.url).href;
    const output = runUnderNode(`
      const { openDurableSqliteDatabase } = await import(${JSON.stringify(url)});
      try {
        openDurableSqliteDatabase("/tmp/should-never-open.db");
        console.log("NO_THROW");
      } catch (error) {
        console.log(error.code);
      }
    `);
    expect(output.trim()).toBe("DB_REQUIRES_BUN_SQLITE");
  });

  test("the db barrel imports cleanly", () => {
    const url = new URL("../src/index.js", import.meta.url).href;
    const output = runUnderNode(`await import(${JSON.stringify(url)}); console.log("imported");`);
    expect(output.trim()).toBe("imported");
  });
});

// Referenced so a rename of the source file fails this test rather than
// silently skipping it.
expect(fileURLToPath(moduleUrl)).toContain("bunSqliteRuntime.js");

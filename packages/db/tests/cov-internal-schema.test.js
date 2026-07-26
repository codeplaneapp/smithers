import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { getTableName } from "drizzle-orm";
import * as monolithic from "../src/internal-schema.js";
import * as barrel from "../src/internal-schema/index.js";

/**
 * The internal schema modules build every Drizzle table with a `(t) => ({...})`
 * extra-config callback (composite PRIMARY KEY / FOREIGN KEY). Drizzle only
 * invokes that callback lazily, when the table's config is materialized —
 * `getTableConfig` forces it, so the callbacks (and the modular files that hold
 * them) are exercised for real rather than merely imported.
 */
function tableEntries(mod) {
  return Object.entries(mod).filter(([, value]) => {
    try {
      return typeof getTableName(value) === "string";
    } catch {
      return false;
    }
  });
}

describe("internal-schema table configs (monolithic internal-schema.js)", () => {
  for (const [name, table] of tableEntries(monolithic)) {
    test(`${name} materializes a valid config`, () => {
      const cfg = getTableConfig(table);
      expect(typeof cfg.name).toBe("string");
      expect(cfg.name.startsWith("_smithers_")).toBe(true);
      expect(Array.isArray(cfg.columns)).toBe(true);
      expect(cfg.columns.length).toBeGreaterThan(0);
      // Touch composite keys / foreign keys so the extraConfig callback ran.
      expect(Array.isArray(cfg.primaryKeys)).toBe(true);
      expect(Array.isArray(cfg.foreignKeys)).toBe(true);
    });
  }
});

describe("internal-schema table configs (modular internal-schema/index.js barrel)", () => {
  for (const [name, table] of tableEntries(barrel)) {
    test(`${name} materializes a valid config`, () => {
      const cfg = getTableConfig(table);
      expect(typeof cfg.name).toBe("string");
      expect(cfg.name.startsWith("_smithers_")).toBe(true);
      expect(cfg.columns.length).toBeGreaterThan(0);
      expect(Array.isArray(cfg.primaryKeys)).toBe(true);
    });
  }
});

test("both modules expose the same set of internal table names", () => {
  const monoNames = new Set(tableEntries(monolithic).map(([, t]) => getTableName(t)));
  const barrelNames = new Set(tableEntries(barrel).map(([, t]) => getTableName(t)));
  // Every modular table name is also reachable from the monolithic surface.
  for (const name of barrelNames) {
    expect(monoNames.has(name)).toBe(true);
  }
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createSmithers } from "../src/index.js";
/**
 * @template Schema
 * @param {Schema} schema
 * @param {string} ddl
 */
export function createTestDb(schema, ddl) {
    const dir = mkdtempSync(join(tmpdir(), "smithers-"));
    const path = join(dir, "db.sqlite");
    const sqlite = new Database(path);
    sqlite.exec(ddl);
    const db = drizzle(sqlite, { schema: schema });
    return {
        db,
        sqlite,
        path,
        cleanup: () => sqlite.close(),
    };
}
/**
 * @template S
 * @param {S} schemas
 */
export function createTestSmithers(schemas) {
    const dir = mkdtempSync(join(tmpdir(), "smithers-"));
    const dbPath = join(dir, "db.sqlite");
    const api = createSmithers(schemas, { dbPath });
    return {
        ...api,
        dbPath,
        cleanup: () => {
            try {
                api.db.$client?.close?.();
            }
            catch { }
        },
    };
}
/**
 * @param {number} ms
 */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * @param {string} tag
 * @param {Record<string, string>} [props]
 * @param {any[]} [children]
 * @returns {XmlElement}
 */
export function el(tag, props = {}, children = []) {
    return { kind: "element", tag, props, children };
}

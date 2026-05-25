import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Stream } from "effect";
import { Database } from "bun:sqlite";
import { SqlMessageStorage } from "../src/sql-message-storage.js";

describe("SqlMessageStorage executeStream", () => {
    test("streams real SQLite query rows through the Effect SqlClient connection", async () => {
        const sqlite = new Database(":memory:");
        const storage = new SqlMessageStorage(sqlite);

        await storage.execute("CREATE TABLE stream_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
        await storage.execute("INSERT INTO stream_items (name) VALUES (?), (?)", ["alpha", "beta"]);

        const rows = await storage.withConnection((connection) => Stream.runCollect(connection.executeStream("SELECT id, name FROM stream_items ORDER BY id", [], undefined)).pipe(Effect.map(Chunk.toReadonlyArray)));

        expect(rows).toEqual([
            { id: 1, name: "alpha" },
            { id: 2, name: "beta" },
        ]);
    });
});

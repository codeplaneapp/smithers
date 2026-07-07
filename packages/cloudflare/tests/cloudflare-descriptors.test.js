import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	createCloudflareD1SqliteDescriptor,
	createCloudflareDurableObjectSqliteDescriptor,
} from "../src/index.js";

/**
 * Build a Durable Object SQL descriptor whose `sql.exec` always returns the
 * supplied cursor-like value, so we can exercise every branch of the internal
 * `rowsFromSqlCursor` / `valuesFromSqlCursor` helpers.
 */
function descriptorReturning(execReturn) {
	return createCloudflareDurableObjectSqliteDescriptor({ exec: () => execReturn });
}

describe("createCloudflareDurableObjectSqliteDescriptor cursor decoding", () => {
	test("queryAllRaw returns [] for a nullish cursor", () => {
		expect(descriptorReturning(null).queryAllRaw("SELECT 1")).toEqual([]);
		expect(descriptorReturning(undefined).queryAllRaw("SELECT 1")).toEqual([]);
	});

	test("queryAllRaw returns an array cursor as-is", () => {
		const rows = [{ a: 1 }, { a: 2 }];
		expect(descriptorReturning(rows).queryAllRaw("SELECT a")).toEqual(rows);
	});

	test("queryAllRaw calls toArray() on a cursor object", () => {
		const desc = descriptorReturning({ toArray: () => [{ b: 3 }] });
		expect(desc.queryAllRaw("SELECT b")).toEqual([{ b: 3 }]);
	});

	test("queryAllRaw returns [] for a truthy cursor without toArray", () => {
		expect(descriptorReturning({ nope: true }).queryAllRaw("SELECT 1")).toEqual([]);
	});

	test("queryValuesRaw returns [] for a nullish cursor", () => {
		expect(descriptorReturning(null).queryValuesRaw("SELECT 1")).toEqual([]);
	});

	test("queryValuesRaw uses raw() when available", () => {
		const desc = descriptorReturning({ raw: () => [[1, 2], [3, 4]] });
		expect(desc.queryValuesRaw("SELECT a, b")).toEqual([[1, 2], [3, 4]]);
	});

	test("queryValuesRaw falls back to Object.values of decoded rows", () => {
		const desc = descriptorReturning({ toArray: () => [{ a: 1, b: 2 }] });
		expect(desc.queryValuesRaw("SELECT a, b")).toEqual([[1, 2]]);
	});

	test("prefers storage.sql over the storage object and binds transaction", async () => {
		const calls = [];
		const storage = {
			sql: { exec: (statement) => { calls.push(statement); return [{ ok: 1 }]; } },
			transaction(operation) {
				return operation();
			},
		};
		const desc = createCloudflareDurableObjectSqliteDescriptor(storage);
		expect(desc.queryAllRaw("SELECT 1")).toEqual([{ ok: 1 }]);
		expect(calls).toEqual(["SELECT 1"]);
		expect(typeof desc.transaction).toBe("function");
		expect(await desc.transaction(() => 42)).toBe(42);
	});

	test("execute passes params through and returns []", () => {
		const seen = [];
		const desc = createCloudflareDurableObjectSqliteDescriptor({
			exec: (statement, ...params) => { seen.push([statement, params]); },
		});
		expect(desc.execute("INSERT INTO t VALUES (?)", ["x"])).toEqual([]);
		expect(seen).toEqual([["INSERT INTO t VALUES (?)", ["x"]]]);
	});

	test("descriptor without a transaction leaves transaction undefined", () => {
		const desc = createCloudflareDurableObjectSqliteDescriptor({ exec: () => [] });
		expect(desc.transaction).toBeUndefined();
	});
});

/**
 * Fake Cloudflare D1 database backed by an in-memory Bun SQLite instance.
 *
 * @param {{ omitRaw?: boolean }} [opts]
 */
function createFakeD1(opts = {}) {
	const sqlite = new Database(":memory:");
	const database = {
		prepare(statement) {
			const returnsRows = /^\s*(select|with|pragma|values)\b/i.test(statement) ||
				/\breturning\b/i.test(statement);
			return {
				bind(...params) {
					const prepared = {
						async all() {
							if (!returnsRows) {
								sqlite.run(statement, ...params);
								return {};
							}
							return { results: sqlite.query(statement).all(...params) };
						},
						async run() {
							sqlite.run(statement, ...params);
							return { success: true };
						},
					};
					if (!opts.omitRaw) {
						prepared.raw = async () => sqlite.query(statement).values(...params);
					}
					return prepared;
				},
			};
		},
	};
	return { database, close: () => sqlite.close() };
}

describe("createCloudflareD1SqliteDescriptor", () => {
	test("round-trips writes and reads through the D1 API", async () => {
		const { database, close } = createFakeD1();
		try {
			const desc = createCloudflareD1SqliteDescriptor(database);
			expect(await desc.execute("CREATE TABLE t (id INTEGER, name TEXT)")).toEqual([]);
			await desc.execute("INSERT INTO t (id, name) VALUES (?, ?)", [1, "a"]);
			await desc.execute("INSERT INTO t (id, name) VALUES (?, ?)", [2, "b"]);

			expect(await desc.queryAllRaw("SELECT id, name FROM t ORDER BY id")).toEqual([
				{ id: 1, name: "a" },
				{ id: 2, name: "b" },
			]);
			expect(await desc.queryValuesRaw("SELECT id, name FROM t ORDER BY id")).toEqual([
				[1, "a"],
				[2, "b"],
			]);
		} finally {
			close();
		}
	});

	test("queryAllRaw returns [] when the D1 result omits results", async () => {
		const { database, close } = createFakeD1();
		try {
			const desc = createCloudflareD1SqliteDescriptor(database);
			// A non-row statement resolves to `{}` (no `results`), exercising `?? []`.
			expect(await desc.queryAllRaw("CREATE TABLE q (id INTEGER)")).toEqual([]);
		} finally {
			close();
		}
	});

	test("queryValuesRaw falls back to all() when raw() is unavailable", async () => {
		const { database, close } = createFakeD1({ omitRaw: true });
		try {
			const desc = createCloudflareD1SqliteDescriptor(database);
			await desc.execute("CREATE TABLE t (id INTEGER, name TEXT)");
			await desc.execute("INSERT INTO t (id, name) VALUES (?, ?)", [7, "z"]);
			expect(await desc.queryValuesRaw("SELECT id, name FROM t")).toEqual([[7, "z"]]);
		} finally {
			close();
		}
	});

	test("transaction is a non-atomic pass-through that returns the operation result", async () => {
		const { database, close } = createFakeD1();
		try {
			const desc = createCloudflareD1SqliteDescriptor(database);
			let ran = false;
			const value = await desc.transaction(async () => {
				ran = true;
				return "done";
			});
			expect(ran).toBe(true);
			expect(value).toBe("done");
		} finally {
			close();
		}
	});
});

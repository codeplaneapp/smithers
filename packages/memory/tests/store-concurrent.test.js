// Concurrency tests for MemoryStore (working memory + threads + messages).
//
// MemoryStore is a thin Drizzle layer over `_smithers_memory_*` tables.
// Concurrency invariants:
//   - setFact uses ON CONFLICT (namespace,key) DO UPDATE → last writer wins.
//   - listFacts/getFact under contention always observe a valid prior write
//     or the latest write — never partial state.
//   - Namespace encoding via `${kind}:${id}` is reversible for the kinds
//     enumerated in MemoryNamespaceKind.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createMemoryStore } from "../src/store/createMemoryStore.js";
import { namespaceToString } from "../src/namespaceToString.js";
import { parseNamespace } from "../src/parseNamespace.js";

function createTestStore() {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite);
	ensureSmithersTables(db);
	return { sqlite, store: createMemoryStore(db) };
}

const NS = { kind: "workflow", id: "race" };

describe("MemoryStore concurrency: setFact", () => {
	test("two parallel setFact on same (ns,key) → last-write-wins, single row", async () => {
		const { sqlite, store } = createTestStore();
		try {
			await Promise.all([
				store.setFact(NS, "k", { v: 1, who: "a" }),
				store.setFact(NS, "k", { v: 2, who: "b" }),
			]);
			const got = await store.getFact(NS, "k");
			expect(got).toBeDefined();
			const value = JSON.parse(got.valueJson);
			// One of the two writes must have won — both are valid.
			expect(["a", "b"]).toContain(value.who);
			expect([1, 2]).toContain(value.v);

			// Exactly one row exists for (ns,key).
			const count = sqlite
				.query(
					"SELECT COUNT(*) AS c FROM _smithers_memory_facts WHERE namespace = ? AND key = ?",
				)
				.get(namespaceToString(NS), "k");
			expect(count?.c).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	test("N concurrent writers on same key → invariant: row count == 1, value is one of the writers", async () => {
		const { sqlite, store } = createTestStore();
		try {
			const N = 20;
			const writers = Array.from({ length: N }, (_, i) =>
				store.setFact(NS, "k", { from: i }),
			);
			await Promise.all(writers);
			const got = await store.getFact(NS, "k");
			const value = JSON.parse(got.valueJson);
			expect(value.from).toBeGreaterThanOrEqual(0);
			expect(value.from).toBeLessThan(N);

			const count = sqlite
				.query(
					"SELECT COUNT(*) AS c FROM _smithers_memory_facts WHERE namespace = ? AND key = ?",
				)
				.get(namespaceToString(NS), "k");
			expect(count?.c).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	test("read-after-write under contention is consistent", async () => {
		const { sqlite, store } = createTestStore();
		try {
			// Seed a baseline value, then run interleaved writes + reads.
			await store.setFact(NS, "counter", { gen: 0 });
			const ITERS = 50;
			const writes = [];
			const reads = [];
			for (let i = 1; i <= ITERS; i += 1) {
				writes.push(store.setFact(NS, "counter", { gen: i }));
				reads.push(store.getFact(NS, "counter"));
			}
			const readResults = await Promise.all(reads);
			await Promise.all(writes);

			for (const fact of readResults) {
				expect(fact).toBeDefined();
				const value = JSON.parse(fact.valueJson);
				expect(value.gen).toBeGreaterThanOrEqual(0);
				expect(value.gen).toBeLessThanOrEqual(ITERS);
			}
			const final = await store.getFact(NS, "counter");
			expect(JSON.parse(final.valueJson).gen).toBe(ITERS);
		} finally {
			sqlite.close();
		}
	});

	test("writes to disjoint keys do not stomp each other under concurrency", async () => {
		const { sqlite, store } = createTestStore();
		try {
			const KEYS = 30;
			await Promise.all(
				Array.from({ length: KEYS }, (_, i) =>
					store.setFact(NS, `key-${i}`, { i }),
				),
			);
			const list = await store.listFacts(NS);
			expect(list.length).toBe(KEYS);
			const ids = list.map((f) => JSON.parse(f.valueJson).i).sort((a, b) => a - b);
			expect(ids).toEqual(Array.from({ length: KEYS }, (_, i) => i));
		} finally {
			sqlite.close();
		}
	});
});

describe("MemoryStore concurrency: namespace encoding", () => {
	test("namespaceToString round-trips for all enumerated kinds (no colon-in-id ambiguity for fixed kinds)", () => {
		// MemoryNamespaceKind enum in parseNamespace: workflow|agent|user|global.
		// IDs may legitimately contain colons (e.g. "task:plan::0"); the parser
		// uses indexOf(":") so the FIRST colon is the kind/id separator and the
		// remainder is the id. Round-trip works as long as the kind is one of
		// the enumerated values.
		const cases = [
			{ kind: "workflow", id: "wf-1" },
			{ kind: "agent", id: "agent:nested:id" },
			{ kind: "user", id: "u/123" },
			{ kind: "global", id: "" },
		];
		for (const ns of cases) {
			const encoded = namespaceToString(ns);
			const decoded = parseNamespace(encoded);
			expect(decoded.kind).toBe(ns.kind);
			expect(decoded.id).toBe(ns.id);
		}
	});

	test("synthetic namespaces with colons do not collapse to the same encoded string", () => {
		// `parseNamespace` rejects unknown kinds and returns `{ kind: "global", id: <raw> }`.
		// So the raw encoded form is what gets persisted in the DB column —
		// these two synthetic namespaces are distinguishable in the DB by
		// namespace string itself, even if parseNamespace can't reverse them.
		const a = { kind: "a", id: "b:c" }; // "a:b%3Ac"
		const b = { kind: "a:b", id: "c" }; // "a:b:c"
		expect(namespaceToString(a)).toBe("a:b%3Ac");
		expect(namespaceToString(b)).toBe("a:b:c");
		expect(namespaceToString(a)).not.toBe(namespaceToString(b));
		expect(parseNamespace("a:b%3Ac")).toEqual({ kind: "global", id: "a:b%3Ac" });
		expect(parseNamespace("a:b:c")).toEqual({ kind: "global", id: "a:b:c" });
	});

	test("writes to two namespaces that DIFFER only by enumerated kind do not collide", async () => {
		const { sqlite, store } = createTestStore();
		try {
			const wf = { kind: "workflow", id: "shared" };
			const agent = { kind: "agent", id: "shared" };
			await Promise.all([
				store.setFact(wf, "k", "wf-val"),
				store.setFact(agent, "k", "agent-val"),
			]);
			const wfFact = await store.getFact(wf, "k");
			const agentFact = await store.getFact(agent, "k");
			expect(JSON.parse(wfFact.valueJson)).toBe("wf-val");
			expect(JSON.parse(agentFact.valueJson)).toBe("agent-val");
		} finally {
			sqlite.close();
		}
	});

	test("writes to enumerated-kind namespaces sharing the encoded prefix remain distinct", async () => {
		// {kind:"workflow", id:"agent:foo"} encodes to "workflow:agent:foo".
		// {kind:"workflow", id:"agent:foo"} is NOT the same encoded string as
		// any other enumerated namespace, so the DB row is distinct.
		const { sqlite, store } = createTestStore();
		try {
			const a = { kind: "workflow", id: "agent:foo" };
			const b = { kind: "workflow", id: "foo:agent" };
			await Promise.all([
				store.setFact(a, "k", "A"),
				store.setFact(b, "k", "B"),
			]);
			expect(JSON.parse((await store.getFact(a, "k")).valueJson)).toBe("A");
			expect(JSON.parse((await store.getFact(b, "k")).valueJson)).toBe("B");
		} finally {
			sqlite.close();
		}
	});
});

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Smithers } from "../src/effect/builder.js";

const inputSchema = Schema.Struct({
	repo: Schema.String,
	sha: Schema.String,
});

const outputSchema = Schema.Struct({
	value: Schema.String,
});

describe("Smithers.workflow", () => {
	test("returns a handle with constructor methods", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		expect(typeof G.step).toBe("function");
		expect(typeof G.approval).toBe("function");
		expect(typeof G.sequence).toBe("function");
		expect(typeof G.parallel).toBe("function");
		expect(typeof G.match).toBe("function");
		expect(typeof G.branch).toBe("function");
		expect(typeof G.loop).toBe("function");
		expect(typeof G.worktree).toBe("function");
		expect(typeof G.scope).toBe("function");
		expect(typeof G.from).toBe("function");
	});

	test("G.step returns a graph value, not a builder handle", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		expect(a._tag).toBe("WorkflowGraph");
		expect(a.expr._tag).toBe("Step");
		// Crucially: not eagerly allocated. No tableName yet because no prefix is bound.
		expect(a.tableName).toBeUndefined();
	});

	test("graph values support .pipe() identity", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		expect(a.pipe()).toBe(a);
	});

	test("graph values support .pipe(f, g) left-to-right", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		const tag = (v) => ({ ...v, tagged: true });
		const named = (v) => ({ ...v, named: "x" });
		const piped = a.pipe(tag, named);
		expect(piped.tagged).toBe(true);
		expect(piped.named).toBe("x");
	});
});

describe("G.from compilation", () => {
	test("returns { execute, node } with node as the compiled BuilderNode", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		const wf = G.from(a);
		expect(typeof wf.execute).toBe("function");
		expect(wf.node).toBeDefined();
		expect(wf.node.kind).toBe("step");
		expect(wf.node.id).toBe("a");
		expect(wf.node.tableName).toBeDefined();
	});

	test("compiles sequence with prefixed step IDs (no prefix at root)", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		const b = G.step("b", { output: outputSchema, run: () => ({ value: "b" }) });
		const wf = G.from(G.sequence(a, b));
		expect(wf.node.kind).toBe("sequence");
		expect(wf.node.children).toHaveLength(2);
		expect(wf.node.children[0].id).toBe("a");
		expect(wf.node.children[1].id).toBe("b");
	});

	test("compiles parallel with maxConcurrency", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		const b = G.step("b", { output: outputSchema, run: () => ({ value: "b" }) });
		const wf = G.from(G.parallel(a, b, { maxConcurrency: 2 }));
		expect(wf.node.kind).toBe("parallel");
		expect(wf.node.children).toHaveLength(2);
		expect(wf.node.maxConcurrency).toBe(2);
	});

	test("compiles match with both branches", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const decide = G.step("decide", { output: outputSchema, run: () => ({ value: "yes" }) });
		const yes = G.step("yes", { output: outputSchema, run: () => ({ value: "yes" }) });
		const no = G.step("no", { output: outputSchema, run: () => ({ value: "no" }) });
		const wf = G.from(
			G.match(decide, {
				when: (v) => v.value === "yes",
				then: yes,
				else: no,
			}),
		);
		expect(wf.node.kind).toBe("match");
		expect(wf.node.source.id).toBe("decide");
		expect(wf.node.then.id).toBe("yes");
		expect(wf.node.else.id).toBe("no");
	});

	test("compiles branch with ctx-based condition", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		const yes = G.step("yes", { output: outputSchema, run: () => ({ value: "yes" }) });
		const wf = G.from(
			G.branch({
				needs: { a },
				condition: (ctx) => ctx.a?.value === "ok",
				then: yes,
			}),
		);
		expect(wf.node.kind).toBe("branch");
		expect(wf.node.needs.a.id).toBe("a");
		expect(wf.node.then.id).toBe("yes");
	});

	test("compiles loop", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		const wf = G.from(
			G.loop({
				id: "retry",
				children: a,
				until: () => true,
				maxIterations: 3,
			}),
		);
		expect(wf.node.kind).toBe("loop");
		expect(wf.node.id).toBe("retry");
		expect(wf.node.maxIterations).toBe(3);
	});

	test("compiles worktree", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		const wf = G.from(
			G.worktree({
				id: "wt",
				path: "scratch/work",
				children: a,
			}),
		);
		expect(wf.node.kind).toBe("worktree");
		expect(wf.node.path).toBe("scratch/work");
		expect(wf.node.children.id).toBe("a");
	});

	test("compiles approval as a distinct kind", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const gate = G.approval("gate", {
			request: () => ({ title: "approve" }),
		});
		const wf = G.from(gate);
		expect(wf.node.kind).toBe("approval");
		expect(wf.node.id).toBe("gate");
	});
});

describe("G.scope", () => {
	test("applies prefix to step IDs", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const make = () => {
			const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
			const b = G.step("b", { output: outputSchema, run: () => ({ value: "b" }) });
			return G.sequence(a, b);
		};
		const wf = G.from(G.scope("api", make()));
		expect(wf.node.children[0].id).toBe("api.a");
		expect(wf.node.children[1].id).toBe("api.b");
	});

	test("same fragment under two scopes produces distinct handle sets", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const make = () => {
			const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
			const b = G.step("b", { needs: { a }, output: outputSchema, run: ({ a }) => ({ value: a.value }) });
			return G.sequence(a, b);
		};
		const wf = G.from(
			G.parallel(G.scope("api", make()), G.scope("web", make())),
		);
		const apiSeq = wf.node.children[0];
		const webSeq = wf.node.children[1];
		expect(apiSeq.children[0].id).toBe("api.a");
		expect(apiSeq.children[1].id).toBe("api.b");
		expect(webSeq.children[0].id).toBe("web.a");
		expect(webSeq.children[1].id).toBe("web.b");
		// And distinct handle objects (different table names).
		expect(apiSeq.children[0]).not.toBe(webSeq.children[0]);
		expect(apiSeq.children[0].tableName).not.toBe(webSeq.children[0].tableName);
	});
});

describe("memoization", () => {
	test("same step value referenced as child and needs source compiles to one handle", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		const b = G.step("b", {
			needs: { a },
			output: outputSchema,
			run: ({ a }) => ({ value: a.value }),
		});
		const wf = G.from(G.sequence(a, b));
		// b.needs.a should be the SAME handle object as the one mounted in the sequence.
		expect(wf.node.children[1].needs.a).toBe(wf.node.children[0]);
	});

	test("same step inside and outside a scope produces distinct handles", () => {
		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const a = G.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		const wf = G.from(G.parallel(a, G.scope("inner", a)));
		const outer = wf.node.children[0];
		const inner = wf.node.children[1];
		expect(outer.id).toBe("a");
		expect(inner.id).toBe("inner.a");
		expect(outer).not.toBe(inner);
	});
});

describe("Smithers.fragment", () => {
	test("returns a factory with all constructors except .from", () => {
		const F = Smithers.fragment(inputSchema);
		expect(typeof F.step).toBe("function");
		expect(typeof F.sequence).toBe("function");
		expect(typeof F.scope).toBe("function");
		expect(F.from).toBeUndefined();
	});

	test("fragment graph values are mountable into a workflow via scope", () => {
		const F = Smithers.fragment(inputSchema);
		const a = F.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		const b = F.step("b", { output: outputSchema, run: () => ({ value: "b" }) });
		const fragment = F.sequence(a, b);

		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const wf = G.from(G.scope("shard", fragment));
		expect(wf.node.kind).toBe("sequence");
		expect(wf.node.children[0].id).toBe("shard.a");
		expect(wf.node.children[1].id).toBe("shard.b");
	});

	test("same fragment mounted into two scopes produces distinct handles", () => {
		const F = Smithers.fragment(inputSchema);
		const a = F.step("a", { output: outputSchema, run: () => ({ value: "a" }) });
		const fragment = F.sequence(a);

		const G = Smithers.workflow({ name: "wf", input: inputSchema });
		const wf = G.from(G.parallel(G.scope("api", fragment), G.scope("web", fragment)));
		expect(wf.node.children[0].children[0].id).toBe("api.a");
		expect(wf.node.children[1].children[0].id).toBe("web.a");
	});
});

describe("removed APIs", () => {
	test("Smithers.createWorkflow is gone", () => {
		expect(Smithers.createWorkflow).toBeUndefined();
	});

	test("Smithers.createComponent is gone", () => {
		expect(Smithers.createComponent).toBeUndefined();
	});
});

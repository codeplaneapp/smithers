/** @jsxImportSource smithers-orchestrator */
import { describe, expect, spyOn, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { extractGraph } from "../src/extract.js";

/**
 * @param {string} tag
 * @param {Record<string, any>} [rawProps]
 * @param {any[]} [children]
 */
function hostEl(tag, rawProps = {}, children = []) {
	const stringProps = {};
	for (const [k, v] of Object.entries(rawProps)) {
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
			stringProps[k] = String(v);
		}
	}
	return { kind: "element", tag, props: stringProps, rawProps, children };
}

/** @param {string} text */
function hostText(text) {
	return { kind: "text", text };
}

/**
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function silenceWorktreePathWarning(fn) {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		return fn();
	}
	finally {
		warn.mockRestore();
	}
}

describe("extractGraph", () => {
	test("returns empty result for null root", () => {
		const result = extractGraph(null);
		expect(result.xml).toBeNull();
		expect(result.tasks).toEqual([]);
		expect(result.mountedTaskIds).toEqual([]);
	});

	test("extracts single static task", () => {
		const root = hostEl("smithers:workflow", {}, [
			hostEl("smithers:task", {
				id: "t1",
				output: "my_table",
				__smithersKind: "static",
				__smithersPayload: { value: 1 },
			}),
		]);
		const result = extractGraph(root);
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0].nodeId).toBe("t1");
		expect(result.tasks[0].outputTableName).toBe("my_table");
		expect(result.tasks[0].staticPayload).toEqual({ value: 1 });
	});

	test("extracts ordinals in order", () => {
		const root = hostEl("smithers:workflow", {}, [
			hostEl("smithers:task", { id: "a", output: "t" }),
			hostEl("smithers:task", { id: "b", output: "t" }),
			hostEl("smithers:task", { id: "c", output: "t" }),
		]);
		const result = extractGraph(root);
		expect(result.tasks.map((t) => t.ordinal)).toEqual([0, 1, 2]);
	});

	test("threads __aspects budget config onto the descriptor", () => {
		const root = hostEl("smithers:workflow", {}, [
			hostEl("smithers:task", {
				id: "t1",
				output: "t",
				__aspects: {
					tokenBudget: { max: 100, perTask: 20, onExceeded: "warn" },
					latencySlo: { maxMs: 30000, onExceeded: "fail" },
					// Render-time fields that must NOT survive extraction.
					tracking: { tokens: true },
					accumulator: { totalTokens: 0 },
				},
			}),
		]);
		const result = extractGraph(root);
		expect(result.tasks[0].aspects).toEqual({
			tokenBudget: { max: 100, perTask: 20, onExceeded: "warn" },
			latencySlo: { maxMs: 30000, onExceeded: "fail" },
		});
	});

	test("omits aspects when no budget configs are present", () => {
		const root = hostEl("smithers:workflow", {}, [
			hostEl("smithers:task", { id: "t1", output: "t", __aspects: { tracking: { tokens: true } } }),
			hostEl("smithers:task", { id: "t2", output: "t" }),
		]);
		const result = extractGraph(root);
		expect(result.tasks[0].aspects).toBeUndefined();
		expect(result.tasks[1].aspects).toBeUndefined();
	});

	test("throws on missing task id", () => {
		expect(() => extractGraph(hostEl("smithers:task", { output: "t" }))).toThrow(
			"Task id is required",
		);
	});

	test("throws on missing task output", () => {
		expect(() => extractGraph(hostEl("smithers:task", { id: "t1" }))).toThrow(
			"missing output",
		);
	});

	test("throws on duplicate task id", () => {
		const root = hostEl("smithers:workflow", {}, [
			hostEl("smithers:task", { id: "dup", output: "t" }),
			hostEl("smithers:task", { id: "dup", output: "t" }),
		]);
		expect(() => extractGraph(root)).toThrow("Duplicate Task id");
	});

	test("text nodes are skipped during walk", () => {
		const root = hostEl("smithers:workflow", {}, [
			hostText("noise"),
			hostEl("smithers:task", { id: "t1", output: "t" }),
		]);
		expect(extractGraph(root).tasks).toHaveLength(1);
	});

	test("generates xml representation", () => {
		const root = hostEl("smithers:workflow", { name: "test" }, [
			hostEl("smithers:task", { id: "t1", output: "t" }),
		]);
		const result = extractGraph(root);
		expect(result.xml).not.toBeNull();
		if (result.xml && result.xml.kind === "element") {
			expect(result.xml.tag).toBe("smithers:workflow");
		}
	});

	test("mountedTaskIds include iteration", () => {
		const result = extractGraph(hostEl("smithers:task", { id: "myTask", output: "t" }));
		expect(result.mountedTaskIds).toEqual(["myTask::0"]);
	});

	describe("agent and compute tasks", () => {
		test("extracts agent kind with prompt", () => {
			const agent = { generate: async () => ({}) };
			const root = hostEl("smithers:task", {
				id: "t1",
				output: "t",
				agent,
				__smithersKind: "agent",
				children: "Write a poem",
			});
			const task = extractGraph(root).tasks[0];
			expect(task.agent).toBe(agent);
			expect(task.prompt).toBe("Write a poem");
		});

		test("extracts compute task", () => {
			const fn = () => ({ value: 1 });
			const root = hostEl("smithers:task", {
				id: "t1",
				output: "t",
				__smithersKind: "compute",
				__smithersComputeFn: fn,
			});
			const task = extractGraph(root).tasks[0];
			expect(task.computeFn).toBe(fn);
			expect(task.staticPayload).toBeUndefined();
		});

		test("extracts human task compute functions", () => {
			const fn = () => ({ answer: "yes" });
			const root = hostEl("smithers:task", {
				id: "review",
				output: "t",
				__smithersKind: "human",
				__smithersComputeFn: fn,
			});
			const task = extractGraph(root).tasks[0];
			expect(task.computeFn).toBe(fn);
			expect(task.staticPayload).toBeUndefined();
		});

		test("throws a clear error for object prompts when MDX preload is inactive", () => {
			const root = hostEl("smithers:task", {
				id: "mdx",
				output: "out",
				agent: { generate: async () => ({}) },
				children: { bad: true },
			});
			expect(() => extractGraph(root)).toThrow("[object Object]");
		});
	});

	describe("outputs", () => {
		test("extracts drizzle table outputs and ignores non-table object outputs", () => {
			const table = sqliteTable("table_out", { runId: text("run_id").primaryKey() });
			const root = hostEl("smithers:workflow", {}, [
				hostEl("smithers:task", { id: "table-task", output: table }),
				hostEl("smithers:task", { id: "object-task", output: { nope: true } }),
			]);
			const result = extractGraph(root);
			expect(result.tasks[0].outputTable).toBe(table);
			expect(result.tasks[0].outputTableName).toBe("table_out");
			expect(result.tasks[1].outputTable).toBeNull();
			expect(result.tasks[1].outputTableName).toBe("");
		});

		test("extracts Zod schema as outputRef", () => {
			const schema = z.object({ value: z.string() });
			const task = extractGraph(hostEl("smithers:task", { id: "t1", output: schema })).tasks[0];
			expect(task.outputRef).toBe(schema);
		});

		test("explicit zod outputSchema overrides outputRef", () => {
			const output = z.object({ value: z.string() });
			const outputSchema = z.object({ value: z.string(), extra: z.number() });
			const task = extractGraph(
				hostEl("smithers:task", { id: "t1", output, outputSchema }),
			).tasks[0];
			expect(task.outputRef).toBe(output);
			expect(task.outputSchema).toBe(outputSchema);
		});

		test("non-zod outputSchema is rejected and falls back to outputRef", () => {
			const output = z.object({ value: z.string() });
			const task = extractGraph(
				hostEl("smithers:task", { id: "t1", output, outputSchema: { not: "zod" } }),
			).tasks[0];
			expect(task.outputSchema).toBe(output);
		});
	});

	describe("retry config", () => {
		test("defaults tasks to infinite retries with exponential backoff", () => {
			const task = extractGraph(hostEl("smithers:task", { id: "t1", output: "t" })).tasks[0];
			expect(task.retries).toBe(Infinity);
			expect(task.retryPolicy).toEqual({ backoff: "exponential", initialDelayMs: 1000 });
		});

		test("noRetry disables default retries and retry policy", () => {
			const task = extractGraph(
				hostEl("smithers:task", { id: "t1", output: "t", noRetry: true }),
			).tasks[0];
			expect(task.retries).toBe(0);
			expect(task.retryPolicy).toBeUndefined();
		});

		test("continueOnFail defaults to no retries for non-agent tasks", () => {
			const task = extractGraph(
				hostEl("smithers:task", { id: "t1", output: "t", continueOnFail: true }),
			).tasks[0];
			expect(task.retries).toBe(0);
			expect(task.retryPolicy).toBeUndefined();
		});

		test("agent tasks get one free retry even with continueOnFail", () => {
			const task = extractGraph(
				hostEl("smithers:task", {
					id: "t1",
					output: "t",
					continueOnFail: true,
					__smithersKind: "agent",
					agent: { generate: async () => ({}) },
				}),
			).tasks[0];
			expect(task.retries).toBe(1);
		});

		test("explicit retries and retryPolicy are respected", () => {
			const policy = { backoff: "exponential", initialDelayMs: 100 };
			const task = extractGraph(
				hostEl("smithers:task", { id: "t1", output: "t", retries: 3, retryPolicy: policy }),
			).tasks[0];
			expect(task.retries).toBe(3);
			expect(task.retryPolicy).toEqual(policy);
		});
	});

	describe("approval options", () => {
		test("extracts rich approval, hijack, memory, scorers, scorer inputs, and agent retry metadata", () => {
			const outputSchema = z.object({ value: z.string() });
			const agent = { generate: async () => ({}) };
			const memory = { namespace: "task" };
			const scorers = { quality: {} };
			const groundTruth = { value: "expected" };
			const context = { document: "source material" };
			const root = hostEl("smithers:task", {
				id: "approval",
				output: "out",
				outputSchema,
				agent,
				continueOnFail: true,
				waitAsync: true,
				needsApproval: true,
				approvalMode: "rank",
				approvalOnDeny: "skip",
				approvalOptions: [
					{ key: "approve", label: "Approve", summary: "ok", metadata: { score: 1 } },
					{ key: "", label: "No key" },
					"bad",
				],
				approvalAllowedScopes: ["admin", 1, "ops"],
				approvalAllowedUsers: ["alice", null, "bob"],
				approvalAutoApprove: { after: 10, audit: true, conditionMet: false, revertOnMet: true },
				heartbeatTimeoutMs: 44.4,
				hijack: true,
				onHijackExit: "reopen",
				memory,
				scorers,
				groundTruth,
				context,
				children: "inspect the diff",
			});
			const task = extractGraph(root).tasks[0];
			expect(task.outputSchema).toBe(outputSchema);
			expect(task.retries).toBe(1);
			expect(task.prompt).toBe("inspect the diff");
			expect(task.waitAsync).toBe(true);
			expect(task.approvalMode).toBe("rank");
			expect(task.approvalOnDeny).toBe("skip");
			expect(task.approvalOptions).toEqual([
				{ key: "approve", label: "Approve", summary: "ok", metadata: { score: 1 } },
			]);
			expect(task.approvalAllowedScopes).toEqual(["admin", "ops"]);
			expect(task.approvalAllowedUsers).toEqual(["alice", "bob"]);
			expect(task.approvalAutoApprove).toEqual({
				after: 10,
				audit: true,
				conditionMet: false,
				revertOnMet: true,
			});
			expect(task.heartbeatTimeoutMs).toBe(44);
			expect(task.hijack).toBe(true);
			expect(task.onHijackExit).toBe("reopen");
			expect(task.memoryConfig).toBe(memory);
			expect(task.scorers).toBe(scorers);
			expect(task.groundTruth).toBe(groundTruth);
			expect(task.context).toBe(context);
		});

		test("rejects array meta and array scorers", () => {
			const task = extractGraph(
				hostEl("smithers:task", { id: "t1", output: "t", meta: ["a"], scorers: ["b"] }),
			).tasks[0];
			expect(task.meta).toBeUndefined();
			expect(task.scorers).toBeUndefined();
		});

		test("approvalMode defaults to gate for unknown modes", () => {
			const task = extractGraph(
				hostEl("smithers:task", { id: "t1", output: "t", approvalMode: "weird" }),
			).tasks[0];
			expect(task.approvalMode).toBe("gate");
		});
	});

	describe("ralph loops", () => {
		test("extracts ralph iteration from Map opts", () => {
			const root = hostEl("smithers:ralph", { id: "myLoop" }, [
				hostEl("smithers:task", { id: "t1", output: "t" }),
			]);
			const result = extractGraph(root, { ralphIterations: new Map([["myLoop", 3]]) });
			expect(result.tasks[0].iteration).toBe(3);
		});

		test("extracts ralph iteration from record opts", () => {
			const root = hostEl("smithers:ralph", { id: "myLoop" }, [
				hostEl("smithers:task", { id: "t1", output: "t" }),
			]);
			const result = extractGraph(root, { ralphIterations: { myLoop: 2 } });
			expect(result.tasks[0].iteration).toBe(2);
		});

		test("throws on nested ralph", () => {
			const root = hostEl("smithers:ralph", { id: "outer" }, [
				hostEl("smithers:ralph", { id: "inner" }, [
					hostEl("smithers:task", { id: "t1", output: "t" }),
				]),
			]);
			expect(() => extractGraph(root)).toThrow("Nested <Ralph>");
		});

		test("throws on duplicate ralph id", () => {
			const root = hostEl("smithers:workflow", {}, [
				hostEl("smithers:ralph", { id: "loop" }, [
					hostEl("smithers:task", { id: "t1", output: "t" }),
				]),
				hostEl("smithers:ralph", { id: "loop" }, [
					hostEl("smithers:task", { id: "t2", output: "t" }),
				]),
			]);
			expect(() => extractGraph(root)).toThrow("Duplicate Ralph id");
		});

		test("scopes task ids by ancestor Ralph loops (nested)", () => {
			const root = hostEl("smithers:ralph", { id: "outer" }, [
				hostEl("smithers:workflow", {}, [
					hostEl("smithers:ralph", { id: "inner" }, [
						hostEl("smithers:task", { id: "work", output: "out" }),
					]),
				]),
			]);
			const result = extractGraph(root, {
				ralphIterations: { outer: 2, "inner@@outer=2": 4 },
			});
			expect(result.tasks[0].nodeId).toBe("work@@outer=2");
			expect(result.tasks[0].ralphId).toBe("inner@@outer=2");
			expect(result.tasks[0].iteration).toBe(4);
			expect(result.mountedTaskIds).toEqual(["work@@outer=2::4"]);
		});
	});

	describe("parallel groups", () => {
		test("parallel assigns group id to tasks", () => {
			const root = hostEl("smithers:parallel", { id: "p1" }, [
				hostEl("smithers:task", { id: "t1", output: "t" }),
				hostEl("smithers:task", { id: "t2", output: "t" }),
			]);
			const result = extractGraph(root);
			expect(result.tasks[0].parallelGroupId).toBe("p1");
			expect(result.tasks[1].parallelGroupId).toBe("p1");
		});

		test("merge-queue defaults concurrency to 1", () => {
			const root = hostEl("smithers:merge-queue", {}, [
				hostEl("smithers:task", { id: "t1", output: "t" }),
			]);
			expect(extractGraph(root).tasks[0].parallelMaxConcurrency).toBe(1);
		});

		test("parallel unbounded concurrency for non-positive values", () => {
			const root = hostEl("smithers:parallel", { maxConcurrency: 0 }, [
				hostEl("smithers:task", { id: "t1", output: "t" }),
			]);
			expect(extractGraph(root).tasks[0].parallelMaxConcurrency).toBeUndefined();
		});

		test("floors fractional parallel concurrency", () => {
			const root = hostEl("smithers:parallel", { id: "p", maxConcurrency: 2.8 }, [
				hostEl("smithers:task", { id: "t1", output: "t" }),
			]);
			expect(extractGraph(root).tasks[0].parallelMaxConcurrency).toBe(2);
		});
	});

	describe("worktrees", () => {
		test("worktree assigns worktreeId, path, branch, baseBranch to tasks", () => {
			const root = hostEl(
				"smithers:worktree",
				{ id: "wt1", path: "workspace", branch: "feature", baseBranch: "main" },
				[hostEl("smithers:task", { id: "t1", output: "t" })],
			);
			const result = silenceWorktreePathWarning(() => extractGraph(root, { baseRootDir: "/tmp/root" }));
			expect(result.tasks[0].worktreeId).toBe("wt1");
			expect(result.tasks[0].worktreePath).toBe("/tmp/root/workspace");
			expect(result.tasks[0].worktreeBranch).toBe("feature");
			expect(result.tasks[0].worktreeBaseBranch).toBe("main");
		});

		test("throws on duplicate worktree id", () => {
			const root = hostEl("smithers:workflow", {}, [
				hostEl("smithers:worktree", { id: "wt", path: "/a" }, [
					hostEl("smithers:task", { id: "t1", output: "t" }),
				]),
				hostEl("smithers:worktree", { id: "wt", path: "/b" }, [
					hostEl("smithers:task", { id: "t2", output: "t" }),
				]),
			]);
			expect(() => extractGraph(root)).toThrow("Duplicate Worktree id");
		});

		test("throws on empty worktree path", () => {
			const root = hostEl("smithers:worktree", { path: "" }, [
				hostEl("smithers:task", { id: "t1", output: "t" }),
			]);
			expect(() => extractGraph(root)).toThrow("non-empty path");
		});
	});

	describe("subflow", () => {
		test("extracts child-run subflow descriptors with scope, groups, and worktree metadata", () => {
			const output = z.object({ value: z.string() });
			const cache = { key: "cache" };
			const root = hostEl("smithers:parallel", { id: "p", maxConcurrency: 2.8 }, [
				hostEl(
					"smithers:worktree",
					{ id: "wt", path: "workspace", branch: "feature", baseBranch: "main" },
					[
						hostEl("smithers:subflow", {
							id: "sf",
							output,
							retries: 2,
							timeoutMs: 3000,
							heartbeatTimeout: 123.8,
							continueOnFail: true,
							skipIf: true,
							cache,
							dependsOn: ["a", 1, "b"],
							needs: { plan: "plan", bad: 1 },
							label: "Subflow",
							meta: { source: "test" },
							__smithersSubflowMode: "childRun",
							__smithersSubflowInput: { prompt: "go" },
						}),
					],
				),
			]);
			const task = silenceWorktreePathWarning(() => extractGraph(root, { baseRootDir: "/tmp/root" })).tasks[0];
			expect(task.nodeId).toBe("sf");
			expect(task.outputRef).toBe(output);
			expect(task.retries).toBe(2);
			expect(task.timeoutMs).toBe(3000);
			expect(task.heartbeatTimeoutMs).toBe(123);
			expect(task.continueOnFail).toBe(true);
			expect(task.skipIf).toBe(true);
			expect(task.cachePolicy).toBe(cache);
			expect(task.dependsOn).toEqual(["a", "b"]);
			expect(task.needs).toEqual({ plan: "plan" });
			expect(task.worktreeId).toBe("wt");
			expect(task.worktreePath).toBe("/tmp/root/workspace");
			expect(task.worktreeBranch).toBe("feature");
			expect(task.worktreeBaseBranch).toBe("main");
			expect(task.parallelGroupId).toBe("p");
			expect(task.parallelMaxConcurrency).toBe(2);
			expect(task.meta).toMatchObject({
				source: "test",
				__subflow: true,
				__subflowMode: "childRun",
				__subflowInput: { prompt: "go" },
			});
		});

		test("inline mode does not create a standalone descriptor", () => {
			const root = hostEl("smithers:workflow", {}, [
				hostEl("smithers:subflow", { id: "sf", mode: "inline", output: "subflow_out" }, [
					hostEl("smithers:task", { id: "inner", output: "inner_out" }),
				]),
			]);
			const result = extractGraph(root);
			expect(result.tasks).toHaveLength(1);
			expect(result.tasks[0].nodeId).toBe("inner");
			expect(result.mountedTaskIds).toEqual(["inner::0"]);
		});

		test("validates subflow id and missing output", () => {
			expect(() => extractGraph(hostEl("smithers:subflow", { output: "out" }))).toThrow(
				"Subflow id is required",
			);
			expect(() => extractGraph(hostEl("smithers:subflow", { id: "sf" }))).toThrow(
				"Subflow sf is missing output",
			);
		});

		test("duplicate subflow id reports the Subflow kind", () => {
			const root = hostEl("smithers:workflow", {}, [
				hostEl("smithers:subflow", { id: "sf", output: "out" }),
				hostEl("smithers:subflow", { id: "sf", output: "out" }),
			]);
			expect(() => extractGraph(root)).toThrow("Duplicate Subflow id detected");
		});
	});

	describe("sandbox", () => {
		test("extracts sandbox as an isolated task and stops descending", () => {
			const provider = { id: "remote", run: async () => ({ status: "finished", output: {} }) };
			const root = hostEl("smithers:workflow", {}, [
				hostEl(
					"smithers:sandbox",
					{
						id: "safe",
						output: "sandbox_out",
						runtime: "docker",
						provider,
						allowNested: true,
						image: "node:22-slim",
						egress: {
							httpsProxy: "http://127.0.0.1:8080",
							noProxy: ["127.0.0.1", "localhost"],
						},
						__smithersSandboxWorkflow: { build: () => null },
					},
					[hostEl("smithers:task", { id: "inside", output: "inner_out" })],
				),
			]);
			const result = extractGraph(root);
			expect(result.tasks).toHaveLength(1);
			expect(result.tasks[0].nodeId).toBe("safe");
			expect(result.tasks[0].outputTableName).toBe("sandbox_out");
			expect(result.tasks[0].meta?.__sandbox).toBe(true);
			expect(result.tasks[0].meta?.__sandboxRuntime).toBe("docker");
			expect(result.tasks[0].meta?.__sandboxProvider).toBe(provider);
			expect(result.tasks[0].meta?.__sandboxAllowNested).toBe(true);
			expect(result.tasks[0].meta?.__sandboxConfig).toMatchObject({
				image: "node:22-slim",
				egress: {
					httpsProxy: "http://127.0.0.1:8080",
					noProxy: ["127.0.0.1", "localhost"],
				},
			});
		});

		test("sandbox runtime is optional for provider-backed sandboxes", () => {
			const provider = { id: "remote", run: async () => ({ status: "finished", output: {} }) };
			const task = extractGraph(
				hostEl("smithers:sandbox", {
					id: "safe",
					output: "sandbox_out",
					provider,
					__smithersSandboxWorkflow: { build: () => null },
				}),
			).tasks[0];
			expect(task.meta?.__sandboxRuntime).toBeUndefined();
			expect(task.meta?.__sandboxProvider).toBe(provider);
		});

		test("sandbox heartbeat defaults to the sandbox heartbeat default", () => {
			const task = extractGraph(
				hostEl("smithers:sandbox", { id: "safe", output: "out" }),
			).tasks[0];
			expect(task.heartbeatTimeoutMs).toBe(600_000);
		});

		test("sandbox missing output throws", () => {
			expect(() => extractGraph(hostEl("smithers:sandbox", { id: "safe" }))).toThrow(
				"Sandbox safe is missing output",
			);
		});

		test("validates sandbox id", () => {
			expect(() => extractGraph(hostEl("smithers:sandbox", { output: "out" }))).toThrow(
				"Sandbox id is required",
			);
		});

		test("duplicate sandbox id reports the Sandbox kind", () => {
			const root = hostEl("smithers:workflow", {}, [
				hostEl("smithers:sandbox", { id: "safe", output: "out" }),
				hostEl("smithers:sandbox", { id: "safe", output: "out" }),
			]);
			expect(() => extractGraph(root)).toThrow("Duplicate Sandbox id detected");
		});
	});

	describe("wait-for-event", () => {
		test("extracts wait-for-event descriptors", () => {
			const output = z.object({ ok: z.boolean() });
			const outputSchema = z.object({ ok: z.boolean(), event: z.string() });
			const root = hostEl("smithers:merge-queue", { id: "mq", maxConcurrency: 0 }, [
				hostEl("smithers:wait-for-event", {
					id: "wait",
					output,
					outputSchema,
					waitAsync: true,
					timeoutMs: 500,
					heartbeatTimeoutMs: 55.9,
					dependsOn: ["a", null, "b"],
					needs: { previous: "task", ignored: false },
					skipIf: true,
					onTimeout: "skip",
					event: "deploy.done",
					correlationId: "corr-1",
					label: "Wait",
					meta: { source: "event" },
				}),
			]);
			const task = extractGraph(root).tasks[0];
			expect(task.nodeId).toBe("wait");
			expect(task.outputRef).toBe(output);
			expect(task.outputSchema).toBe(outputSchema);
			expect(task.waitAsync).toBe(true);
			expect(task.timeoutMs).toBe(500);
			expect(task.heartbeatTimeoutMs).toBe(55);
			expect(task.dependsOn).toEqual(["a", "b"]);
			expect(task.needs).toEqual({ previous: "task" });
			expect(task.retries).toBe(0);
			expect(task.continueOnFail).toBe(true);
			expect(task.parallelGroupId).toBe("mq");
			expect(task.parallelMaxConcurrency).toBe(1);
			expect(task.meta).toMatchObject({
				source: "event",
				__waitForEvent: true,
				__eventName: "deploy.done",
				__correlationId: "corr-1",
				__onTimeout: "skip",
			});
		});

		test("validates wait-for-event id and missing output", () => {
			expect(() => extractGraph(hostEl("smithers:wait-for-event", { output: "out" }))).toThrow(
				"WaitForEvent id is required",
			);
			expect(() => extractGraph(hostEl("smithers:wait-for-event", { id: "wait" }))).toThrow(
				"WaitForEvent wait is missing output",
			);
		});

		test("duplicate wait-for-event id reports the WaitForEvent kind", () => {
			const root = hostEl("smithers:workflow", {}, [
				hostEl("smithers:wait-for-event", { id: "wait", output: "out" }),
				hostEl("smithers:wait-for-event", { id: "wait", output: "out" }),
			]);
			expect(() => extractGraph(root)).toThrow("Duplicate WaitForEvent id detected");
		});
	});

	describe("timer", () => {
		test("extracts timers with duration and absolute scheduling", () => {
			const until = new Date("2026-01-02T03:04:05.000Z");
			const root = hostEl("smithers:workflow", {}, [
				hostEl("smithers:timer", {
					id: "delay",
					duration: " 5m ",
					dependsOn: ["a", 1, "b"],
					needs: { previous: "task", ignored: true },
					skipIf: true,
					label: "Delay",
					meta: { source: "timer" },
				}),
				hostEl("smithers:timer", { id: "absolute", until }),
			]);
			const result = extractGraph(root);
			expect(result.tasks[0]).toMatchObject({
				nodeId: "delay",
				label: "Delay",
				dependsOn: ["a", "b"],
				needs: { previous: "task" },
				skipIf: true,
				retries: 0,
				continueOnFail: false,
			});
			expect(result.tasks[0].meta).toMatchObject({
				source: "timer",
				__timer: true,
				__timerType: "duration",
				__timerDuration: "5m",
			});
			expect(result.tasks[1].label).toBe("timer:absolute");
			expect(result.tasks[1].meta).toMatchObject({
				__timerType: "absolute",
				__timerUntil: "2026-01-02T03:04:05.000Z",
			});
		});

		test("validates timer ids and schedule shape", () => {
			expect(() => extractGraph(hostEl("smithers:timer", { duration: "1s" }))).toThrow(
				"Timer id is required",
			);
			expect(() =>
				extractGraph(hostEl("smithers:timer", { id: "x".repeat(257), duration: "1s" })),
			).toThrow("256 characters");
			expect(() => extractGraph(hostEl("smithers:timer", { id: "bad" }))).toThrow("exactly one");
			expect(() =>
				extractGraph(hostEl("smithers:timer", { id: "bad", duration: "1s", until: "tomorrow" })),
			).toThrow("exactly one");
			expect(() =>
				extractGraph(hostEl("smithers:timer", { id: "bad", duration: "1s", every: "1m" })),
			).toThrow("recurring timers");
		});

		test("duplicate timer id reports the Timer kind", () => {
			const root = hostEl("smithers:workflow", {}, [
				hostEl("smithers:timer", { id: "dup", duration: "1s" }),
				hostEl("smithers:timer", { id: "dup", duration: "2s" }),
			]);
			expect(() => extractGraph(root)).toThrow("Duplicate Timer id detected");
		});
	});

	describe("saga and try-catch-finally", () => {
		test("detects duplicate saga and try-catch-finally ids", () => {
			expect(() =>
				extractGraph(
					hostEl("smithers:workflow", {}, [
						hostEl("smithers:saga", { id: "s" }),
						hostEl("smithers:saga", { id: "s" }),
					]),
				),
			).toThrow("Duplicate Saga id");
			expect(() =>
				extractGraph(
					hostEl("smithers:workflow", {}, [
						hostEl("smithers:try-catch-finally", { id: "tcf" }),
						hostEl("smithers:try-catch-finally", { id: "tcf" }),
					]),
				),
			).toThrow("Duplicate TryCatchFinally id");
		});
	});
});

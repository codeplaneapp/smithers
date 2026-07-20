import { describe, expect, test } from "bun:test";
import { createMockGcpSandboxEnvironment } from "../src/createMockGcpSandboxEnvironment.js";

/** Drive a runJob the way the runner does, so we exercise the exec path directly. */
async function runJob(env, { command = "echo hi", requestObject = "req", resultObject = "res", request = { runId: "r" } } = {}) {
	env.objects.set(requestObject, JSON.stringify(request));
	const [operation] = await env.run.runJob({
		name: "projects/p/locations/l/jobs/j",
		overrides: {
			containerOverrides: [{
				args: ["sh", "-c", command],
				env: [
					{ name: "SMITHERS_SANDBOX_REQUEST_GCS_OBJECT", value: requestObject },
					{ name: "SMITHERS_SANDBOX_RESULT_GCS_OBJECT", value: resultObject },
				],
			}],
		},
	});
	const [execution] = await operation.promise();
	return execution;
}

describe("createMockGcpSandboxEnvironment", () => {
	test("storage save/download round-trips content", async () => {
		const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
		await env.storage.bucket("b").file("o").save("hello");
		const [buf] = await env.storage.bucket("b").file("o").download();
		expect(buf.toString("utf-8")).toBe("hello");
	});

	test("storage delete removes the object", async () => {
		const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
		await env.storage.bucket("b").file("o").save("x");
		await env.storage.bucket("b").file("o").delete();
		expect(env.objects.has("o")).toBe(false);
	});

	test("runJob invokes the handler with command, request, files, env", async () => {
		let seen;
		const env = createMockGcpSandboxEnvironment((args) => {
			seen = args;
			return { status: "finished", output: { ok: true } };
		});
		await runJob(env, { command: "node run.js", request: { runId: "R", input: { a: 1 } } });
		expect(seen.command).toBe("node run.js");
		expect(seen.request).toEqual({ runId: "R", input: { a: 1 } });
		expect(seen.files).toBeInstanceOf(Map);
		expect(seen.env.SMITHERS_SANDBOX_REQUEST_GCS_OBJECT).toBe("req");
	});

	test("runJob writes the handler result to the result object and returns a succeeded execution", async () => {
		const env = createMockGcpSandboxEnvironment(() => ({ status: "finished", output: { n: 2 } }));
		const execution = await runJob(env);
		expect(JSON.parse(env.objects.get("res"))).toEqual({ status: "finished", output: { n: 2 } });
		expect(execution.succeededCount).toBe(1);
		expect(execution.failedCount).toBe(0);
		expect(execution.name).toContain("/executions/exec-");
	});

	test("deterministic, incrementing execution names", async () => {
		const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
		const first = await runJob(env);
		const second = await runJob(env);
		expect(first.name).toContain("exec-1");
		expect(second.name).toContain("exec-2");
	});

	test("runJob operation exposes the execution resource via LRO metadata", async () => {
		const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
		const [operation] = await env.run.runJob({
			name: "projects/p/locations/l/jobs/j",
			overrides: { containerOverrides: [{ env: [], args: ["sh", "-c", "echo hi"] }] },
		});
		expect(typeof operation.metadata?.name).toBe("string");
		expect(String(operation.metadata.name)).toContain("/executions/");
	});

	test("injectable failed execution counts + conditions (no handler call, no result)", async () => {
		let called = false;
		const env = createMockGcpSandboxEnvironment(() => {
			called = true;
			return { status: "finished" };
		}, { execution: { succeededCount: 0, failedCount: 1, conditions: [{ type: "Completed", state: "CONDITION_FAILED", message: "OOM" }] } });
		const execution = await runJob(env);
		expect(called).toBe(false);
		expect(execution.failedCount).toBe(1);
		expect(execution.conditions[0].message).toBe("OOM");
		expect(env.objects.has("res")).toBe(false);
	});

	test("createJob / deleteJob record requests and return LROs", async () => {
		const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
		const [createOp] = await env.run.createJob({ parent: "projects/p/locations/l", jobId: "j" });
		await createOp.promise();
		const [deleteOp] = await env.run.deleteJob({ name: "projects/p/locations/l/jobs/j" });
		await deleteOp.promise();
		expect(env.createdJobs.length).toBe(1);
		expect(env.deletedJobs.length).toBe(1);
	});

	test("destroy marks destroyed and exec after destroy rejects", async () => {
		const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
		env.destroy();
		expect(env.destroyed).toBe(true);
		await expect(runJob(env)).rejects.toThrow(/destroyed/);
	});

	test("fault injection: save, download, run, createJob reject", async () => {
		const saveEnv = createMockGcpSandboxEnvironment(() => ({ status: "finished" }), { faults: { save: true } });
		await expect(saveEnv.storage.bucket("b").file("o").save("x")).rejects.toThrow(/save/);

		const dlEnv = createMockGcpSandboxEnvironment(() => ({ status: "finished" }), { faults: { download: true } });
		await expect(dlEnv.storage.bucket("b").file("o").download()).rejects.toThrow(/download/);

		const runEnv = createMockGcpSandboxEnvironment(() => ({ status: "finished" }), { faults: { run: true } });
		await expect(runEnv.run.runJob({ name: "n", overrides: {} })).rejects.toThrow(/runJob/);

		const cjEnv = createMockGcpSandboxEnvironment(() => ({ status: "finished" }), { faults: { createJob: true } });
		await expect(cjEnv.run.createJob({ jobId: "j" })).rejects.toThrow(/createJob/);
	});
});

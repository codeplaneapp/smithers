import { describe, expect, test } from "bun:test";
import { createGcpCloudRunJobsSandboxRunner } from "../src/createGcpCloudRunJobsSandboxRunner.js";

/** Minimal JobsClient double that records requests and resolves a scripted execution. */
function makeJobsClient(execution, { failRun = false } = {}) {
	const calls = { run: [], create: [], delete: [] };
	return {
		calls,
		jobPath: (p, l, j) => `projects/${p}/locations/${l}/jobs/${j}`,
		locationPath: (p, l) => `projects/${p}/locations/${l}`,
		async runJob(request) {
			if (failRun) throw new Error("runJob boom");
			calls.run.push(request);
			return [{ promise: async () => [execution] }];
		},
		async createJob(request) {
			calls.create.push(request);
			return [{ promise: async () => [{}] }];
		},
		async deleteJob(request) {
			calls.delete.push(request);
			return [{ promise: async () => [{}] }];
		},
	};
}

const BASE = { projectId: "p", location: "l", jobName: "j" };

describe("createGcpCloudRunJobsSandboxRunner", () => {
	test("succeededCount === 1 yields exit 0 and empty stdout", async () => {
		const client = makeJobsClient({ name: "exec-a", succeededCount: 1, failedCount: 0 });
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		const result = await runner.run({ command: "echo hi", env: { A: "1" } });
		expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
	});

	test("failedCount > 0 yields exit 1 with condition message as stderr", async () => {
		const client = makeJobsClient({ name: "exec-b", succeededCount: 0, failedCount: 1, conditions: [{ type: "Completed", state: "CONDITION_FAILED", message: "container crashed" }] });
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		const result = await runner.run({ command: "false", env: {} });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("container crashed");
	});

	test("passes args=[sh,-c,command], env list, and timeout into runJob overrides", async () => {
		const client = makeJobsClient({ name: "exec-c", succeededCount: 1 });
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE, timeoutSec: 120 });
		await runner.run({ command: "node r.js", env: { FOO: "bar" } });
		const overrides = client.calls.run[0].overrides;
		expect(overrides.containerOverrides[0].args).toEqual(["sh", "-c", "node r.js"]);
		expect(overrides.containerOverrides[0].env).toEqual([{ name: "FOO", value: "bar" }]);
		expect(overrides.timeout).toEqual({ seconds: 120 });
	});

	test("derives timeout from timeoutMs when timeoutSec is absent", async () => {
		const client = makeJobsClient({ name: "exec-d", succeededCount: 1 });
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		await runner.run({ command: "x", env: {}, timeoutMs: 5000 });
		expect(client.calls.run[0].overrides.timeout).toEqual({ seconds: 5 });
	});

	test("remoteId is the job path before exec and the execution name after", async () => {
		const client = makeJobsClient({ name: "projects/p/locations/l/jobs/j/executions/exec-e", succeededCount: 1 });
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		expect(runner.remoteId).toBe("projects/p/locations/l/jobs/j");
		await runner.run({ command: "x", env: {} });
		expect(runner.remoteId).toContain("/executions/exec-e");
	});

	test("createJob creates a per-run job before running and deleteJob removes it", async () => {
		const client = makeJobsClient({ name: "exec-f", succeededCount: 1 });
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE, createJob: true, image: "gcr.io/smithers/sandbox-runner" });
		await runner.run({ command: "x", env: {} });
		expect(client.calls.create.length).toBe(1);
		expect(runner.createdJob).toBe(true);
		await runner.deleteJob();
		expect(client.calls.delete.length).toBe(1);
	});

	test("reused job never creates or deletes", async () => {
		const client = makeJobsClient({ name: "exec-g", succeededCount: 1 });
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		await runner.run({ command: "x", env: {} });
		await runner.deleteJob();
		expect(client.calls.create.length).toBe(0);
		expect(client.calls.delete.length).toBe(0);
	});

	test("aborted signal throws before running", async () => {
		const client = makeJobsClient({ name: "exec-h", succeededCount: 1 });
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		const controller = new AbortController();
		controller.abort();
		await expect(runner.run({ command: "x", env: {}, signal: controller.signal })).rejects.toThrow(/cancel/i);
		expect(client.calls.run.length).toBe(0);
	});

	test("falls back to a constructed job resource name when jobPath is absent", async () => {
		const execution = { name: "exec-nopath", succeededCount: 1 };
		const client = {
			async runJob() {
				return [{ promise: async () => [execution] }];
			},
		};
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		expect(runner.remoteId).toBe("projects/p/locations/l/jobs/j");
		await runner.run({ command: "x", env: {} });
	});

	test("createJob without an image or template rejects with INVALID_INPUT", async () => {
		const client = makeJobsClient({ name: "exec-noimg", succeededCount: 1 });
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE, createJob: true });
		await expect(runner.run({ command: "x", env: {} })).rejects.toThrow(/requires a container image/);
	});

	test("createJob folds runner env into the created container's env list", async () => {
		const client = makeJobsClient({ name: "exec-env", succeededCount: 1 });
		const runner = createGcpCloudRunJobsSandboxRunner({
			jobsClient: client,
			...BASE,
			createJob: true,
			image: "gcr.io/smithers/runner",
			workingDir: "/workspace",
			env: { BUILD_ENV: "ci" },
			timeoutSec: 90,
		});
		await runner.run({ command: "x", env: {} });
		const job = client.calls.create[0].job;
		const container = job.template.template.containers[0];
		expect(container.image).toBe("gcr.io/smithers/runner");
		expect(container.workingDir).toBe("/workspace");
		expect(container.env).toEqual([{ name: "BUILD_ENV", value: "ci" }]);
		expect(job.template.template.timeout).toEqual({ seconds: 90 });
	});

	test("a rejected execution LRO surfaces the underlying error", async () => {
		const client = {
			jobPath: (p, l, j) => `projects/${p}/locations/${l}/jobs/${j}`,
			async runJob() {
				return [{ promise: async () => { throw new Error("execution LRO failed"); } }];
			},
		};
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		await expect(runner.run({ command: "x", env: {} })).rejects.toThrow(/execution LRO failed/);
	});

	test("createJob merges pre-existing container templates into the created job", async () => {
		const client = makeJobsClient({ name: "exec-tmpl", succeededCount: 1 });
		const runner = createGcpCloudRunJobsSandboxRunner({
			jobsClient: client,
			...BASE,
			createJob: true,
			taskTemplate: { containers: [{ image: "tmpl-img", resources: { limits: { cpu: "1" } } }, { name: "sidecar" }] },
		});
		await runner.run({ command: "x", env: {} });
		const containers = client.calls.create[0].job.template.template.containers;
		expect(containers[0].image).toBe("tmpl-img");
		expect(containers[0].resources).toEqual({ limits: { cpu: "1" } });
		expect(containers[1]).toEqual({ name: "sidecar" });
	});

	test("createJob requires a client that exposes createJob()", async () => {
		const client = {
			jobPath: (p, l, j) => `projects/${p}/locations/${l}/jobs/${j}`,
			locationPath: (p, l) => `projects/${p}/locations/${l}`,
			async runJob() {
				return [{ promise: async () => [{ name: "exec-x", succeededCount: 1 }] }];
			},
		};
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE, createJob: true, image: "img" });
		await expect(runner.run({ command: "x", env: {} })).rejects.toThrow(/requires a JobsClient with createJob/);
	});

	test("a failed Completed condition (no counts) maps to exit 1 with its message", async () => {
		const client = makeJobsClient({
			name: "exec-cond",
			succeededCount: 0,
			failedCount: 0,
			conditions: [{ type: "Completed", state: "CONDITION_FAILED", message: "timed out" }],
		});
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		const result = await runner.run({ command: "x", env: {} });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("timed out");
	});

	test("no failure signal at all maps to exit 0", async () => {
		const client = makeJobsClient({
			name: "exec-ok",
			succeededCount: 0,
			failedCount: 0,
			conditions: [{ type: "Completed", state: "CONDITION_SUCCEEDED" }],
		});
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		const result = await runner.run({ command: "x", env: {} });
		expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
	});

	test("abort falls back to deleteExecution when cancelExecution is absent", async () => {
		const deleted = [];
		const client = {
			jobPath: (p, l, j) => `projects/${p}/locations/${l}/jobs/${j}`,
			async runJob(request) {
				return [{
					promise: () => new Promise(() => {}),
					metadata: { name: `${request.name}/executions/exec-del` },
				}];
			},
			async deleteExecution(request) {
				deleted.push(request);
				return [{ promise: async () => [{}] }];
			},
		};
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		const controller = new AbortController();
		const pending = runner.run({ command: "x", env: {}, signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await expect(pending).rejects.toThrow(/cancel/i);
		expect(deleted.length).toBe(1);
		expect(String(deleted[0].name)).toContain("/executions/");
	});

	test("abort after runJob starts rejects promptly and attempts cancellation", async () => {
		const cancelled = [];
		let lroCancelled = false;
		const client = {
			jobPath: (p, l, j) => `projects/${p}/locations/${l}/jobs/${j}`,
			async runJob(request) {
				// A never-resolving execution LRO: without racing the abort, run()
				// would hang until Cloud Run finished. The LRO metadata carries the
				// Execution resource being created, which the runner must target.
				return [{
					promise: () => new Promise(() => {}),
					cancel: async () => { lroCancelled = true; },
					metadata: { name: `${request.name}/executions/exec-abort` },
				}];
			},
			async cancelExecution(request) {
				cancelled.push(request);
				return [{ promise: async () => [{}] }];
			},
		};
		const runner = createGcpCloudRunJobsSandboxRunner({ jobsClient: client, ...BASE });
		const controller = new AbortController();
		const pending = runner.run({ command: "x", env: {}, signal: controller.signal });
		// Let ensureJob + runJob settle and the abort listener attach.
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await expect(pending).rejects.toThrow(/cancel/i);
		expect(cancelled.length).toBe(1);
		// Must target the Execution resource (from LRO metadata), not the job.
		expect(String(cancelled[0].name)).toContain("/executions/");
		expect(lroCancelled).toBe(true);
	});
});

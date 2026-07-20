import { describe, expect, test } from "bun:test";
import { createMockAwsSandboxEnvironment } from "../src/index.js";

/**
 * @param {ReturnType<typeof createMockAwsSandboxEnvironment>} env
 * @param {{ command?: string[]; environment?: Array<{ name: string; value: string }> }} [overrides]
 */
async function seedAndRunTask(env, overrides = {}) {
	const requestKey = "smithers/sandbox/run/sbx/sandbox-request.json";
	const resultKey = "smithers/sandbox/run/sbx/sandbox-result.json";
	await env.s3.putObject({ Bucket: "b", Key: requestKey, Body: JSON.stringify({ runId: "run", sandboxId: "sbx" }) });
	const runRes = await env.ecs.runTask({
		cluster: "c",
		overrides: {
			containerOverrides: [
				{
					name: "runner",
					command: overrides.command ?? ["sh", "-c", "node run.js"],
					environment: overrides.environment ?? [
						{ name: "SMITHERS_SANDBOX_REQUEST_S3_KEY", value: requestKey },
						{ name: "SMITHERS_SANDBOX_RESULT_S3_KEY", value: resultKey },
					],
				},
			],
		},
	});
	return { runRes, requestKey, resultKey };
}

describe("createMockAwsSandboxEnvironment", () => {
	test("stores files and exposes deterministic ecs task ids", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const { runRes } = await seedAndRunTask(env);
		const arn = runRes.tasks[0].taskArn;
		expect(arn).toContain("arn:aws:ecs:");
		expect(arn.endsWith("/1")).toBe(true);
		expect(env.store.has("smithers/sandbox/run/sbx/sandbox-request.json")).toBe(true);
	});

	test("runTask invokes the handler with command, request, files, and env then writes the result to S3", async () => {
		/** @type {any} */
		let seen;
		const env = createMockAwsSandboxEnvironment((args) => {
			seen = args;
			return { status: "finished", output: { ok: 1 } };
		});
		const { resultKey } = await seedAndRunTask(env);
		expect(seen.command).toBe("node run.js");
		expect(seen.request).toEqual({ runId: "run", sandboxId: "sbx" });
		expect(seen.files instanceof Map).toBe(true);
		expect(seen.env.SMITHERS_SANDBOX_RESULT_S3_KEY).toBe(resultKey);
		const stored = JSON.parse(env.store.get(resultKey) ?? "{}");
		expect(stored).toEqual({ status: "finished", output: { ok: 1 } });
	});

	test("describeTasks reports STOPPED with the configured exit code", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), { exitCode: 7 });
		const { runRes } = await seedAndRunTask(env);
		const arn = runRes.tasks[0].taskArn;
		const res = await env.ecs.describeTasks({ cluster: "c", tasks: [arn] });
		expect(res.tasks[0].lastStatus).toBe("STOPPED");
		expect(res.tasks[0].containers[0].exitCode).toBe(7);
	});

	test("codebuild round-trips the handler and reports the configured status", async () => {
		/** @type {any} */
		let seen;
		const env = createMockAwsSandboxEnvironment((args) => {
			seen = args;
			return { status: "finished" };
		}, { buildStatus: "SUCCEEDED" });
		const requestKey = "smithers/sandbox/run/sbx/sandbox-request.json";
		const resultKey = "smithers/sandbox/run/sbx/sandbox-result.json";
		await env.s3.putObject({ Bucket: "b", Key: requestKey, Body: JSON.stringify({ runId: "run" }) });
		const start = await env.codebuild.startBuild({
			projectName: "p",
			buildspecOverride: 'version: 0.2\nphases:\n  build:\n    commands:\n      - "node run.js"\n',
			environmentVariablesOverride: [
				{ name: "SMITHERS_SANDBOX_REQUEST_S3_KEY", value: requestKey, type: "PLAINTEXT" },
				{ name: "SMITHERS_SANDBOX_RESULT_S3_KEY", value: resultKey, type: "PLAINTEXT" },
			],
		});
		expect(seen.command).toBe("node run.js");
		const got = await env.codebuild.batchGetBuilds({ ids: [start.build.id] });
		expect(got.builds[0].buildStatus).toBe("SUCCEEDED");
		expect(env.store.has(resultKey)).toBe(true);
	});

	test("destroy marks destroyed and blocks further use", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		env.destroy();
		expect(env.destroyed).toBe(true);
		await expect(env.ecs.runTask({ cluster: "c", overrides: { containerOverrides: [{}] } })).rejects.toThrow(/after destroy/);
		await expect(env.s3.putObject({ Bucket: "b", Key: "k", Body: "x" })).rejects.toThrow(/after destroy/);
	});

	test("fault injection: create/exec/upload/download reject", async () => {
		const createEnv = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), { faults: { create: true } });
		await expect(createEnv.ecs.runTask({ cluster: "c", overrides: { containerOverrides: [{}] } })).rejects.toThrow(/RunTask fault/);

		const uploadEnv = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), { faults: { upload: true } });
		await expect(uploadEnv.s3.putObject({ Bucket: "b", Key: "k", Body: "x" })).rejects.toThrow(/PutObject fault/);

		const downloadEnv = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), { faults: { download: true } });
		await expect(downloadEnv.s3.getObject({ Bucket: "b", Key: "k" })).rejects.toThrow(/GetObject fault/);

		const execEnv = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), { faults: { exec: true } });
		const { runRes, resultKey } = await seedAndRunTask(execEnv);
		const arn = runRes.tasks[0].taskArn;
		const res = await execEnv.ecs.describeTasks({ cluster: "c", tasks: [arn] });
		// exec fault: nonzero exit, no result written.
		expect(res.tasks[0].containers[0].exitCode).not.toBe(0);
		expect(execEnv.store.has(resultKey)).toBe(false);
	});
});

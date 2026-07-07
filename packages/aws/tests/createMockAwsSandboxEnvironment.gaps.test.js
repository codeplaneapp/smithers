import { describe, expect, test } from "bun:test";
import { createMockAwsSandboxEnvironment } from "../src/index.js";

/**
 * @param {ReturnType<typeof createMockAwsSandboxEnvironment>} env
 * @param {string[]} command
 */
async function runTask(env, command) {
	const requestKey = "smithers/sandbox/run/sbx/req.json";
	const resultKey = "smithers/sandbox/run/sbx/res.json";
	await env.s3.putObject({ Bucket: "b", Key: requestKey, Body: JSON.stringify({ runId: "run" }) });
	const res = await env.ecs.runTask({
		cluster: "c",
		overrides: {
			containerOverrides: [
				{
					name: "runner",
					command,
					environment: [
						{ name: "SMITHERS_SANDBOX_REQUEST_S3_KEY", value: requestKey },
						{ name: "SMITHERS_SANDBOX_RESULT_S3_KEY", value: resultKey },
					],
				},
			],
		},
	});
	return { arn: res.tasks[0].taskArn, resultKey };
}

describe("createMockAwsSandboxEnvironment — remaining surface", () => {
	test("stopTask marks the task STOPPED and records it", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const { arn } = await runTask(env, ["sh", "-c", "echo hi"]);
		await env.ecs.stopTask({ task: arn });
		const res = await env.ecs.describeTasks({ cluster: "c", tasks: [arn] });
		expect(res.tasks[0].lastStatus).toBe("STOPPED");
		expect(env.stoppedTasks).toContain(arn);
	});

	test("command and env getters expose the last invocation", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		await runTask(env, ["sh", "-c", "run-me.sh"]);
		expect(env.command).toBe("run-me.sh");
		expect(env.env.SMITHERS_SANDBOX_REQUEST_S3_KEY).toBe("smithers/sandbox/run/sbx/req.json");
	});

	test("codebuild command falls back to the raw buildspec line when it is not JSON", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		await env.s3.putObject({ Bucket: "b", Key: "req", Body: "{}" });
		await env.codebuild.startBuild({
			projectName: "p",
			buildspecOverride: "version: 0.2\nphases:\n  build:\n    commands:\n      - raw-unquoted-command\n",
			environmentVariablesOverride: [{ name: "SMITHERS_SANDBOX_REQUEST_S3_KEY", value: "req" }],
		});
		expect(env.command).toBe("raw-unquoted-command");
	});

	test("setExitCode changes the reported container exit code", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		env.setExitCode(42);
		const { arn } = await runTask(env, ["sh", "-c", "x"]);
		const res = await env.ecs.describeTasks({ cluster: "c", tasks: [arn] });
		expect(res.tasks[0].containers[0].exitCode).toBe(42);
	});

	test("setStoppedReason surfaces on describeTasks", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		env.setStoppedReason("OutOfMemory");
		const { arn } = await runTask(env, ["sh", "-c", "x"]);
		const res = await env.ecs.describeTasks({ cluster: "c", tasks: [arn] });
		expect(res.tasks[0].stoppedReason).toBe("OutOfMemory");
	});

	test("setBuildStatus changes the reported CodeBuild status", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		env.setBuildStatus("FAILED");
		await env.s3.putObject({ Bucket: "b", Key: "req", Body: "{}" });
		const start = await env.codebuild.startBuild({
			projectName: "p",
			buildspecOverride: 'version: 0.2\nphases:\n  build:\n    commands:\n      - "node x.js"\n',
			environmentVariablesOverride: [{ name: "SMITHERS_SANDBOX_REQUEST_S3_KEY", value: "req" }],
		});
		const got = await env.codebuild.batchGetBuilds({ ids: [start.build.id] });
		expect(got.builds[0].buildStatus).toBe("FAILED");
	});

	test("setWriteResult(false) suppresses writing the result object", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		env.setWriteResult(false);
		const { resultKey } = await runTask(env, ["sh", "-c", "x"]);
		expect(env.store.has(resultKey)).toBe(false);
	});

	test("setFault toggles a fault after construction", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		env.setFault("upload");
		await expect(env.s3.putObject({ Bucket: "b", Key: "k", Body: "x" })).rejects.toThrow(/PutObject fault/);
	});
});

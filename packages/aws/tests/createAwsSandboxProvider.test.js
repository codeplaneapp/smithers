import { describe, expect, test } from "bun:test";
import { AWS_SANDBOX_PROVIDER_ID, createAwsSandboxProvider, createMockAwsSandboxEnvironment } from "../src/index.js";

const FARGATE_OPTS = {
	region: "us-east-1",
	bucket: "smithers-sandbox-test",
	cluster: "smithers",
	taskDefinition: "smithers-sandbox:1",
	subnets: ["subnet-abc123"],
	containerName: "runner",
};

const CODEBUILD_OPTS = {
	mode: "codebuild",
	region: "us-east-1",
	bucket: "smithers-sandbox-test",
	projectName: "smithers-sandbox",
};

let counter = 0;

/**
 * @param {Record<string, unknown>} [overrides]
 */
function makeRequest(overrides = {}) {
	/** @type {unknown[]} */
	const heartbeats = [];
	const seq = counter++;
	const request = {
		runId: `run-${seq}`,
		sandboxId: `sbx-${seq}`,
		input: { topic: "aws" },
		config: { flavor: "spicy" },
		rootDir: `/tmp/aws-${seq}/root`,
		requestBundlePath: `/tmp/aws-${seq}/request`,
		resultBundlePath: `/tmp/aws-${seq}/result`,
		workflow: /** @type {any} */ ({ build: () => null }),
		executeChildWorkflow: async () => ({ runId: "child", status: "finished", output: null }),
		allowNetwork: false,
		maxOutputBytes: 1_000_000,
		toolTimeoutMs: 60_000,
		config_unused: undefined,
		heartbeat: (/** @type {unknown} */ data) => heartbeats.push(data ?? {}),
		...overrides,
	};
	return { request: /** @type {any} */ (request), heartbeats };
}

describe("createAwsSandboxProvider — options validation", () => {
	test("default id and custom id", () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		expect(createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS }).id).toBe(AWS_SANDBOX_PROVIDER_ID);
		expect(createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS, id: "custom" }).id).toBe("custom");
	});

	test("invalid mode rejected", () => {
		expect(() => createAwsSandboxProvider({ ...FARGATE_OPTS, mode: /** @type {any} */ ("lambda") })).toThrow(/must be "fargate" or "codebuild"/);
	});

	test("missing region rejected", () => {
		expect(() => createAwsSandboxProvider({ ...FARGATE_OPTS, region: undefined })).toThrow(/region/);
	});

	test("missing bucket rejected", () => {
		expect(() => createAwsSandboxProvider({ ...FARGATE_OPTS, bucket: undefined })).toThrow(/bucket/);
	});

	test("invalid cleanup rejected", () => {
		expect(() => createAwsSandboxProvider({ ...FARGATE_OPTS, cleanup: /** @type {any} */ ("nuke") })).toThrow(/cleanup/);
	});

	test("empty command rejected (kit)", () => {
		expect(() => createAwsSandboxProvider({ ...FARGATE_OPTS, command: "   " })).toThrow(/command/);
	});

	test("fargate missing cluster/taskDefinition/subnets/containerName rejected", () => {
		expect(() => createAwsSandboxProvider({ ...FARGATE_OPTS, cluster: undefined })).toThrow(/cluster/);
		expect(() => createAwsSandboxProvider({ ...FARGATE_OPTS, taskDefinition: undefined })).toThrow(/taskDefinition/);
		expect(() => createAwsSandboxProvider({ ...FARGATE_OPTS, subnets: [] })).toThrow(/subnets/);
		expect(() => createAwsSandboxProvider({ ...FARGATE_OPTS, containerName: undefined })).toThrow(/containerName/);
	});

	test("codebuild missing projectName rejected", () => {
		expect(() => createAwsSandboxProvider({ ...CODEBUILD_OPTS, projectName: undefined })).toThrow(/projectName/);
	});
});

describe("createAwsSandboxProvider — fargate happy path", () => {
	test("runs a request via injected ECS/S3 doubles and parses the result file", async () => {
		/** @type {any} */
		let seen;
		const env = createMockAwsSandboxEnvironment((args) => {
			seen = args;
			return { status: "finished", output: { done: true } };
		});
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS, command: "node run.js" });
		const { request, heartbeats } = makeRequest();
		const result = await provider.run(request);

		expect(result.status).toBe("finished");
		expect(result.output).toEqual({ done: true });
		// remote ids resolve to the real task ARN once launched.
		expect(String(result.remoteRunId)).toContain("arn:aws:ecs:");
		expect(String(result.containerId)).toContain("arn:aws:ecs:");

		// request JSON carried input + config through S3.
		expect(seen.request.input).toEqual({ topic: "aws" });
		expect(seen.request.config).toEqual({ flavor: "spicy" });
		// the actual command reached the container.
		expect(seen.command).toBe("node run.js");
		// env has the kit path vars AND the S3 round-trip vars.
		expect(typeof seen.env.SMITHERS_SANDBOX_REQUEST_PATH).toBe("string");
		expect(typeof seen.env.SMITHERS_SANDBOX_RESULT_PATH).toBe("string");
		expect(seen.env.SMITHERS_SANDBOX_S3_BUCKET).toBe("smithers-sandbox-test");
		expect(seen.env.SMITHERS_SANDBOX_S3_PREFIX).toBe(`smithers/sandbox/${request.runId}/${request.sandboxId}`);
		expect(seen.env.SMITHERS_SANDBOX_REQUEST_S3_KEY.endsWith("sandbox-request.json")).toBe(true);
		expect(seen.env.SMITHERS_SANDBOX_RESULT_S3_KEY.endsWith("sandbox-result.json")).toBe(true);

		// heartbeat stages present.
		const stages = heartbeats.map((h) => /** @type {any} */ (h).stage);
		expect(stages).toContain(`${AWS_SANDBOX_PROVIDER_ID}-session-created`);
		expect(stages).toContain(`${AWS_SANDBOX_PROVIDER_ID}-request-shipped`);
		expect(stages).toContain(`${AWS_SANDBOX_PROVIDER_ID}-result-read`);
	});

	test("fargate awsvpc network configuration carries subnets, security groups, and public IP", async () => {
		/** @type {any} */
		let runInput;
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const runTask = env.ecs.runTask;
		env.ecs.runTask = async (input) => {
			runInput = input;
			return runTask(input);
		};
		const provider = createAwsSandboxProvider({
			clients: env,
			...FARGATE_OPTS,
			securityGroups: ["sg-1"],
			assignPublicIp: "ENABLED",
		});
		await provider.run(makeRequest().request);
		const awsvpc = runInput.networkConfiguration.awsvpcConfiguration;
		expect(awsvpc.subnets).toEqual(["subnet-abc123"]);
		expect(awsvpc.securityGroups).toEqual(["sg-1"]);
		expect(awsvpc.assignPublicIp).toBe("ENABLED");
		expect(runInput.launchType).toBe("FARGATE");
		expect(runInput.overrides.containerOverrides[0].command).toEqual(["sh", "-c", expect.any(String)]);
	});

	test("nonzero container exit surfaces as SANDBOX_EXECUTION_FAILED", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), { exitCode: 3 });
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS });
		await expect(provider.run(makeRequest().request)).rejects.toThrow(/exited with code 3/);
	});

	test("cancellation via aborted signal surfaces", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS });
		const controller = new AbortController();
		controller.abort();
		await expect(provider.run(makeRequest({ signal: controller.signal }).request)).rejects.toThrow(/cancel/i);
	});

	test("cleanup destroy stops the task and deletes transient S3 objects", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS });
		const { request } = makeRequest();
		await provider.run(request);
		const prefix = `smithers/sandbox/${request.runId}/${request.sandboxId}`;
		expect(env.store.has(`${prefix}/sandbox-request.json`)).toBe(true);
		await provider.cleanup?.(request);
		expect(env.stoppedTasks.length).toBe(1);
		expect(env.store.has(`${prefix}/sandbox-request.json`)).toBe(false);
	});

	test("cleanup keep leaves the task and objects", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS, cleanup: "keep" });
		const { request } = makeRequest();
		await provider.run(request);
		await provider.cleanup?.(request);
		expect(env.stoppedTasks.length).toBe(0);
		expect(env.store.has(`smithers/sandbox/${request.runId}/${request.sandboxId}/sandbox-request.json`)).toBe(true);
	});

	test("captureLogs surfaces CloudWatch output in the failure detail, redacted", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), {
			exitCode: 2,
			logEvents: ["boom failing log line"],
		});
		const provider = createAwsSandboxProvider({
			clients: env,
			...FARGATE_OPTS,
			captureLogs: true,
			logGroupName: "/aws/ecs/smithers",
		});
		await expect(provider.run(makeRequest().request)).rejects.toThrow(/boom failing log line/);
	});
});

describe("createAwsSandboxProvider — failure injection & redaction", () => {
	test("RunTask (create) failure is surfaced without leaking secrets", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), {
			faults: { create: true },
			faultMessage: "denied for AUTHVAL",
		});
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS, env: { AUTH_TOKEN: "AUTHVAL" } });
		let message = "";
		try {
			await provider.run(makeRequest().request);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/RunTask/);
		expect(message).not.toContain("AUTHVAL");
	});

	test("S3 upload failure is surfaced without leaking secrets", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), {
			faults: { upload: true },
			faultMessage: "put denied SEKRET",
		});
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS, env: { API_SECRET: "SEKRET" } });
		let message = "";
		try {
			await provider.run(makeRequest().request);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/S3 upload failed/);
		expect(message).not.toContain("SEKRET");
	});

	test("exec fault (no result written, nonzero exit) surfaces", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), { faults: { exec: true } });
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS });
		await expect(provider.run(makeRequest().request)).rejects.toThrow(/exited with code/);
	});
});

describe("createAwsSandboxProvider — codebuild mode", () => {
	test("runs a request through CodeBuild and maps SUCCEEDED to a finished bundle", async () => {
		/** @type {any} */
		let seen;
		const env = createMockAwsSandboxEnvironment((args) => {
			seen = args;
			return { status: "finished", output: { via: "codebuild" } };
		}, { buildStatus: "SUCCEEDED" });
		const provider = createAwsSandboxProvider({ clients: env, ...CODEBUILD_OPTS, command: "node run.js" });
		const result = await provider.run(makeRequest().request);
		expect(result.status).toBe("finished");
		expect(result.output).toEqual({ via: "codebuild" });
		expect(String(result.remoteRunId)).toContain("smithers-sandbox:");
		expect(seen.command).toBe("node run.js");
		expect(seen.env.SMITHERS_SANDBOX_S3_PREFIX).toContain("smithers/sandbox/");
	});

	test("FAILED build with a written failed bundle passes the failed status through", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "failed", output: { reason: "tests" } }), {
			buildStatus: "SUCCEEDED",
		});
		const provider = createAwsSandboxProvider({ clients: env, ...CODEBUILD_OPTS });
		const result = await provider.run(makeRequest().request);
		expect(result.status).toBe("failed");
	});

	test("codebuild build-status FAILED with no result surfaces as execution failure", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), {
			faults: { exec: true },
		});
		const provider = createAwsSandboxProvider({ clients: env, ...CODEBUILD_OPTS });
		await expect(provider.run(makeRequest().request)).rejects.toThrow(/exited with code 1|no result JSON/i);
	});

	test("cleanup destroy stops the build", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const provider = createAwsSandboxProvider({ clients: env, ...CODEBUILD_OPTS });
		const { request } = makeRequest();
		await provider.run(request);
		await provider.cleanup?.(request);
		expect(env.stoppedBuilds.length).toBe(1);
	});
});

import { describe, expect, test } from "bun:test";
import { AWS_SANDBOX_PROVIDER_ID, createAwsSandboxProvider, createAwsSandboxS3Transport, createMockAwsSandboxEnvironment } from "../src/index.js";

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

	test("cleanup destroy skips StopTask for an already-stopped task and deletes transient S3 objects", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS });
		const { request } = makeRequest();
		await provider.run(request);
		const prefix = `smithers/sandbox/${request.runId}/${request.sandboxId}`;
		const requestKey = `${prefix}/${encodeURIComponent(".smithers/sandbox-request.json")}`;
		expect(env.store.has(requestKey)).toBe(true);
		await provider.cleanup?.(request);
		// N8: the poll already observed STOPPED, so no redundant StopTask is issued.
		expect(env.stoppedTasks.length).toBe(0);
		expect(env.store.has(requestKey)).toBe(false);
	});

	test("cleanup destroy deletes the container-authored RESULT object (Finding 5)", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished", output: { done: true } }));
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS });
		const { request } = makeRequest();
		await provider.run(request);
		const prefix = `smithers/sandbox/${request.runId}/${request.sandboxId}`;
		// The result JSON is written by the container and fetched via readFile; it is
		// never registered as a "written" key, so before the fix it leaked past destroy.
		const resultKey = `${prefix}/${encodeURIComponent(".smithers/sandbox-result.json")}`;
		expect(env.store.has(resultKey)).toBe(true);
		await provider.cleanup?.(request);
		expect(env.store.has(resultKey)).toBe(false);
	});

	test("provider built with singular `client` alias runs identically to `clients` (Finding 15)", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished", output: { via: "alias" } }));
		const provider = createAwsSandboxProvider({ client: env, ...FARGATE_OPTS, command: "node run.js" });
		const result = await provider.run(makeRequest().request);
		expect(result.status).toBe("finished");
		expect(result.output).toEqual({ via: "alias" });
		expect(String(result.remoteRunId)).toContain("arn:aws:ecs:");
	});

	test("cleanup keep leaves the task and objects", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS, cleanup: "keep" });
		const { request } = makeRequest();
		await provider.run(request);
		await provider.cleanup?.(request);
		expect(env.stoppedTasks.length).toBe(0);
		const requestKey = `smithers/sandbox/${request.runId}/${request.sandboxId}/${encodeURIComponent(".smithers/sandbox-request.json")}`;
		expect(env.store.has(requestKey)).toBe(true);
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

	test("sub-5-minute toolTimeoutMs clamps timeoutInMinutesOverride to 5, not 1 (Finding 9)", async () => {
		/** @type {any} */
		let startInput;
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const startBuild = env.codebuild.startBuild;
		env.codebuild.startBuild = async (input) => {
			startInput = input;
			return startBuild(input);
		};
		const provider = createAwsSandboxProvider({ clients: env, ...CODEBUILD_OPTS });
		// makeRequest defaults toolTimeoutMs to 60_000 (1 minute) → ceil is 1, but
		// CodeBuild requires 5..2160, so StartBuild would reject with 1.
		await provider.run(makeRequest({ toolTimeoutMs: 60_000 }).request);
		expect(startInput.timeoutInMinutesOverride).toBe(5);
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

/**
 * Minimal in-memory S3 double for the transport unit test.
 */
function memoryS3() {
	/** @type {Map<string, string>} */
	const store = new Map();
	return {
		store,
		/** @param {Record<string, any>} input */
		async putObject(input) {
			store.set(String(input.Key), String(input.Body));
			return {};
		},
		/** @param {Record<string, any>} input */
		async getObject(input) {
			const key = String(input.Key);
			if (!store.has(key)) throw new Error(`NoSuchKey: ${key}`);
			return { Body: store.get(key) };
		},
		/** @param {Record<string, any>} input */
		async deleteObjects(input) {
			for (const obj of input?.Delete?.Objects ?? []) store.delete(String(obj.Key));
			return {};
		},
	};
}

describe("createAwsSandboxS3Transport — collision-free keying (C3)", () => {
	test("two distinct paths sharing a basename map to distinct keys and round-trip independently", async () => {
		const s3 = memoryS3();
		const transport = createAwsSandboxS3Transport({ s3, bucket: "b", prefix: "smithers/sandbox/run/sbx", workdir: "/workspace" });

		const keyA = transport.keyForPath("/workspace/a/config.json");
		const keyB = transport.keyForPath("/workspace/b/config.json");
		expect(keyA).not.toBe(keyB);
		// Both still live under the session prefix.
		expect(keyA.startsWith("smithers/sandbox/run/sbx/")).toBe(true);
		expect(keyB.startsWith("smithers/sandbox/run/sbx/")).toBe(true);

		await transport.writeFile("/workspace/a/config.json", "AAA");
		await transport.writeFile("/workspace/b/config.json", "BBB");
		// No collision in the underlying store: two objects, not one.
		expect(s3.store.size).toBe(2);
		expect(await transport.readFile("/workspace/a/config.json")).toBe("AAA");
		expect(await transport.readFile("/workspace/b/config.json")).toBe("BBB");
	});

	test("keying strips the workdir prefix and encodes the relative path", () => {
		const s3 = memoryS3();
		const transport = createAwsSandboxS3Transport({ s3, bucket: "b", prefix: "p", workdir: "/workspace" });
		expect(transport.keyForPath("/workspace/.smithers/sandbox-request.json")).toBe(`p/${encodeURIComponent(".smithers/sandbox-request.json")}`);
	});
});

describe("createAwsSandboxProvider — egress CA S3 key injection (N3-aws)", () => {
	const CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIBfakecert\n-----END CERTIFICATE-----";

	test("injects SMITHERS_SANDBOX_CA_S3_KEY (keyed like request/result) when egress.caCertPem is set, and the CA object exists at that key", async () => {
		/** @type {any} */
		let seen;
		const env = createMockAwsSandboxEnvironment((args) => {
			seen = args;
			return { status: "finished" };
		});
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS });
		const { request } = makeRequest({ egress: { caCertPem: CA_PEM } });
		await provider.run(request);

		const prefix = `smithers/sandbox/${request.runId}/${request.sandboxId}`;
		const expectedKey = `${prefix}/${encodeURIComponent(".smithers/egress/ca.crt")}`;
		expect(seen.env.SMITHERS_SANDBOX_CA_S3_KEY).toBe(expectedKey);
		// The CA object was actually uploaded to that key by the kit.
		expect(env.store.get(expectedKey)).toBe(CA_PEM);
	});

	test("omits SMITHERS_SANDBOX_CA_S3_KEY when egress carries no caCertPem", async () => {
		/** @type {any} */
		let seen;
		const env = createMockAwsSandboxEnvironment((args) => {
			seen = args;
			return { status: "finished" };
		});
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS });
		await provider.run(makeRequest().request);
		expect(seen.env.SMITHERS_SANDBOX_CA_S3_KEY).toBeUndefined();
	});
});

describe("createAwsSandboxProvider — awslogs stream prefix (N6)", () => {
	test("captureLogs reads a custom awslogs stream prefix", async () => {
		/** @type {string | undefined} */
		let streamName;
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), { logEvents: ["hello log"] });
		const getLogEvents = env.logs.getLogEvents;
		env.logs.getLogEvents = async (input) => {
			streamName = /** @type {any} */ (input).logStreamName;
			return getLogEvents(input);
		};
		const provider = createAwsSandboxProvider({
			clients: env,
			...FARGATE_OPTS,
			captureLogs: true,
			logGroupName: "/aws/ecs/smithers",
			awslogsStreamPrefix: "my-prefix",
		});
		await provider.run(makeRequest().request);
		expect(streamName).toMatch(/^my-prefix\/runner\/\d+$/);
	});

	test("captureLogs defaults the stream prefix to the container name", async () => {
		/** @type {string | undefined} */
		let streamName;
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }), { logEvents: ["hello log"] });
		const getLogEvents = env.logs.getLogEvents;
		env.logs.getLogEvents = async (input) => {
			streamName = /** @type {any} */ (input).logStreamName;
			return getLogEvents(input);
		};
		const provider = createAwsSandboxProvider({
			clients: env,
			...FARGATE_OPTS,
			captureLogs: true,
			logGroupName: "/aws/ecs/smithers",
		});
		await provider.run(makeRequest().request);
		expect(streamName).toMatch(/^runner\/runner\/\d+$/);
	});
});

describe("createAwsSandboxProvider — no redundant StopTask after STOPPED (N8)", () => {
	test("cleanup does not call StopTask once the task has already reached STOPPED", async () => {
		const env = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const provider = createAwsSandboxProvider({ clients: env, ...FARGATE_OPTS });
		const { request } = makeRequest();
		await provider.run(request);
		// The task stopped on its own during the run, so cleanup must not re-stop it.
		await provider.cleanup?.(request);
		expect(env.stoppedTasks.length).toBe(0);
	});
});

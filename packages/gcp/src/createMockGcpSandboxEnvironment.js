const REQUEST_OBJECT_ENV = "SMITHERS_SANDBOX_REQUEST_GCS_OBJECT";
const RESULT_OBJECT_ENV = "SMITHERS_SANDBOX_RESULT_GCS_OBJECT";

/**
 * In-memory double for the `@google-cloud/storage` + `@google-cloud/run` subset
 * that `createGcpSandboxProvider` calls. It simulates a Cloud Storage bucket
 * (an object Map with save/download/delete) and Cloud Run Jobs (`runJob`
 * returning an LRO whose promise resolves an Execution). The exec path parses
 * the request object from mock GCS, invokes `handler`, writes the returned
 * result JSON to the result object, and resolves a succeeded Execution.
 *
 * This is what makes tests run with ZERO GCP credentials and NO real bucket.
 *
 * @param {(args: { command: string; request: Record<string, unknown>; files: Map<string, string>; env: Record<string, string> }) => import("@smithers-orchestrator/sandbox").SandboxProviderResult | Promise<import("@smithers-orchestrator/sandbox").SandboxProviderResult>} handler
 * @param {{
 *   faults?: { save?: boolean; download?: boolean; run?: boolean; createJob?: boolean; deleteJob?: boolean };
 *   execution?: { succeededCount?: number; failedCount?: number; conditions?: Array<{ type?: string; state?: string; message?: string }>; name?: string };
 * }} [config]
 */
export function createMockGcpSandboxEnvironment(handler, config = {}) {
	const faults = config.faults ?? {};
	/** @type {Map<string, string>} objectName -> content */
	const objects = new Map();
	/** @type {Array<Record<string, unknown>>} */
	const runRequests = [];
	/** @type {Array<Record<string, unknown>>} */
	const createdJobs = [];
	/** @type {Array<Record<string, unknown>>} */
	const deletedJobs = [];
	let executionCounter = 0;
	let destroyed = false;

	/** @param {() => Promise<[unknown]>} resolve */
	function lro(resolve) {
		return [{ promise: resolve }];
	}

	const storage = {
		/** @param {string} _name */
		bucket(_name) {
			return {
				/** @param {string} objectName */
				file(objectName) {
					return {
						/** @param {string | Uint8Array} content */
						async save(content) {
							if (faults.save) throw new Error("mock GCS save() failed");
							objects.set(objectName, typeof content === "string" ? content : new TextDecoder().decode(content));
						},
						async download() {
							if (faults.download) throw new Error("mock GCS download() failed");
							return [Buffer.from(objects.get(objectName) ?? "", "utf-8")];
						},
						async delete() {
							objects.delete(objectName);
							return [{}];
						},
					};
				},
			};
		},
	};

	const run = {
		/**
		 * @param {string} project
		 * @param {string} location
		 * @param {string} job
		 */
		jobPath(project, location, job) {
			return `projects/${project}/locations/${location}/jobs/${job}`;
		},
		/**
		 * @param {string} project
		 * @param {string} location
		 */
		locationPath(project, location) {
			return `projects/${project}/locations/${location}`;
		},
		/** @param {Record<string, unknown>} request */
		async createJob(request) {
			if (faults.createJob) throw new Error("mock Cloud Run createJob() failed");
			createdJobs.push(request);
			return lro(async () => [{ name: `${request.jobId}` }]);
		},
		/** @param {Record<string, unknown>} request */
		async deleteJob(request) {
			if (faults.deleteJob) throw new Error("mock Cloud Run deleteJob() failed");
			deletedJobs.push(request);
			return lro(async () => [{}]);
		},
		/** @param {{ name: string; overrides?: { containerOverrides?: Array<{ env?: Array<{ name: string; value: string }>; args?: string[] }> } }} request */
		async runJob(request) {
			if (destroyed) throw new Error("mock GCP sandbox environment is destroyed");
			if (faults.run) throw new Error("mock Cloud Run runJob() failed");
			runRequests.push(request);
			const executionName = `${request.name}/executions/exec-${++executionCounter}`;

			const resolveExecution = async () => {
				// A configured failed execution simulates an infra failure: the
				// container never wrote a result, so the kit throws on the empty read.
				const failedCount = Number(config.execution?.failedCount ?? 0);
				if (failedCount > 0) {
					return [{
						name: config.execution?.name ?? executionName,
						succeededCount: Number(config.execution?.succeededCount ?? 0),
						failedCount,
						conditions: config.execution?.conditions ?? [{ type: "Completed", state: "CONDITION_FAILED", message: "task failed" }],
					}];
				}

				const container = request.overrides?.containerOverrides?.[0] ?? {};
				const args = container.args ?? [];
				const command = args.length >= 3 ? String(args[2]) : "";
				/** @type {Record<string, string>} */
				const env = {};
				for (const entry of container.env ?? []) {
					env[entry.name] = entry.value;
				}

				const requestObject = env[REQUEST_OBJECT_ENV];
				const resultObject = env[RESULT_OBJECT_ENV];
				const request_ = JSON.parse(requestObject ? objects.get(requestObject) ?? "{}" : "{}");
				const files = new Map(objects);
				const result = await handler({ command, request: request_, files, env });
				if (resultObject) {
					objects.set(resultObject, JSON.stringify(result));
				}

				return [{
					name: config.execution?.name ?? executionName,
					succeededCount: Number(config.execution?.succeededCount ?? 1),
					failedCount: 0,
					conditions: config.execution?.conditions ?? [{ type: "Completed", state: "CONDITION_SUCCEEDED" }],
				}];
				};
				return [{ promise: resolveExecution, metadata: { name: executionName } }];
		},
	};

	return {
		storage,
		run,
		objects,
		runRequests,
		createdJobs,
		deletedJobs,
		get destroyed() {
			return destroyed;
		},
		/** Simulate the whole environment going away (exec after destroy rejects). */
		destroy() {
			destroyed = true;
		},
	};
}

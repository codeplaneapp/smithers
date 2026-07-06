import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { createCommandSandboxProvider, SANDBOX_PROVIDER_REQUEST_ENV, SANDBOX_PROVIDER_RESULT_ENV } from "@smithers-orchestrator/sandbox";
import { AWS_SANDBOX_PROVIDER_ID } from "./AWS_SANDBOX_PROVIDER_ID.js";
import { createAwsCodeBuildSandboxRunner } from "./createAwsCodeBuildSandboxRunner.js";
import { createAwsEcsSandboxRunner } from "./createAwsEcsSandboxRunner.js";
import { createAwsSandboxS3Transport } from "./createAwsSandboxS3Transport.js";
import { resolveAwsSdkClient } from "./resolveAwsSdkClient.js";

const DEFAULT_WORKDIR = "/workspace";
const SECRET_KEY_RE = /token|secret|key|password|credential|authorization|passwd|apikey/i;

/**
 * @param {Record<string, string> | undefined} env
 * @returns {string[]}
 */
function secretValuesFrom(env) {
	if (!env) return [];
	const out = [];
	for (const [key, value] of Object.entries(env)) {
		if (SECRET_KEY_RE.test(key) && typeof value === "string" && value.length > 0) out.push(value);
	}
	return out;
}

/**
 * Build a Smithers SandboxProvider backed by AWS. Because AWS has no shared
 * filesystem between the orchestrator and the remote task, the request/result
 * bundle is transported through S3: `writeFile`/`readFile` map a workdir path to
 * `s3://<bucket>/smithers/sandbox/<runId>/<sandboxId>/<basename(path)>`, and the
 * remote container round-trips the same keys via the injected
 * `SMITHERS_SANDBOX_S3_*` env vars.
 *
 * @param {import("./AwsSandboxProviderOptions.ts").AwsSandboxProviderOptions} [options]
 * @returns {import("@smithers-orchestrator/sandbox").SandboxProvider}
 */
export function createAwsSandboxProvider(options = {}) {
	const id = options.id ?? AWS_SANDBOX_PROVIDER_ID;
	const mode = options.mode ?? "fargate";
	if (mode !== "fargate" && mode !== "codebuild") {
		throw new SmithersError("INVALID_INPUT", 'AWS sandbox `mode` must be "fargate" or "codebuild".', { provider: id, mode });
	}
	const region = typeof options.region === "string" ? options.region.trim() : "";
	if (!region) throw new SmithersError("INVALID_INPUT", "AWS sandbox provider requires a `region`.", { provider: id });
	const bucket = typeof options.bucket === "string" ? options.bucket.trim() : "";
	if (!bucket) throw new SmithersError("INVALID_INPUT", "AWS sandbox provider requires an existing S3 `bucket` for the bundle transport.", { provider: id });

	const cleanup = options.cleanup ?? "destroy";
	if (cleanup !== "destroy" && cleanup !== "keep") {
		throw new SmithersError("INVALID_INPUT", 'AWS sandbox `cleanup` must be "destroy" or "keep".', { provider: id, cleanup });
	}

	// Validate mode-specific required options up front for a fast, clear failure.
	if (mode === "fargate") {
		if (!options.cluster) throw new SmithersError("INVALID_INPUT", "AWS fargate sandbox requires a `cluster`.", { provider: id });
		if (!options.taskDefinition) throw new SmithersError("INVALID_INPUT", "AWS fargate sandbox requires a `taskDefinition`.", { provider: id });
		if (!Array.isArray(options.subnets) || options.subnets.filter((s) => typeof s === "string" && s.length > 0).length === 0) {
			throw new SmithersError("INVALID_INPUT", "AWS fargate sandbox requires at least one `subnets` entry.", { provider: id });
		}
		if (!options.containerName) throw new SmithersError("INVALID_INPUT", "AWS fargate sandbox requires a `containerName`.", { provider: id });
	} else {
		if (!options.projectName) throw new SmithersError("INVALID_INPUT", "AWS codebuild sandbox requires a `projectName`.", { provider: id });
	}

	const clients = options.clients ?? options.client ?? {};
	const clientOptions = { region, ...(options.clientOptions ?? {}) };
	const secrets = secretValuesFrom(options.env);
	const workdir = options.workdir ?? DEFAULT_WORKDIR;

	return createCommandSandboxProvider({
		id,
		command: options.command,
		workdir,
		env: options.env,
		cleanup,
		/**
		 * @param {import("@smithers-orchestrator/sandbox").SandboxProviderRequest} request
		 * @returns {Promise<import("@smithers-orchestrator/sandbox").SandboxSession>}
		 */
		async createSession(request) {
			const prefix = `smithers/sandbox/${request.runId}/${request.sandboxId}`;
			const s3 = /** @type {any} */ (await resolveAwsSdkClient({
				injected: clients.s3,
				moduleName: "@aws-sdk/client-s3",
				clientExport: "S3Client",
				methods: ["putObject", "getObject", "deleteObjects"],
				clientOptions,
			}));
			const transport = createAwsSandboxS3Transport({ s3, bucket, prefix, secrets });

			const logs = options.captureLogs
				? await resolveAwsSdkClient({
						injected: clients.logs,
						moduleName: "@aws-sdk/client-cloudwatch-logs",
						clientExport: "CloudWatchLogsClient",
						methods: ["getLogEvents"],
						clientOptions,
					})
				: undefined;

			const runner = mode === "codebuild"
				? await createAwsCodeBuildSandboxRunner({
						client: clients.codebuild,
						clientOptions,
						projectName: options.projectName,
						bucket,
						prefix,
						captureLogs: options.captureLogs,
						logs,
						maxOutputBytes: request.maxOutputBytes,
						secrets,
					})
				: await createAwsEcsSandboxRunner({
						client: clients.ecs,
						clientOptions,
						cluster: options.cluster,
						taskDefinition: options.taskDefinition,
						subnets: options.subnets,
						securityGroups: options.securityGroups,
						assignPublicIp: options.assignPublicIp,
						containerName: options.containerName,
						region,
						captureLogs: options.captureLogs,
						logs,
						logGroupName: options.logGroupName,
						maxOutputBytes: request.maxOutputBytes,
						secrets,
					});

			const syntheticId = `${request.runId}-${request.sandboxId}`;

			return {
				get remoteId() {
					return runner.remoteId ?? syntheticId;
				},
				writeFile: transport.writeFile,
				readFile: transport.readFile,
				/**
				 * @param {string} command
				 * @param {import("@smithers-orchestrator/sandbox").SandboxExecOptions} execOpts
				 * @returns {Promise<import("@smithers-orchestrator/sandbox").SandboxExecResult>}
				 */
				async exec(command, execOpts) {
					const requestPath = execOpts.env[SANDBOX_PROVIDER_REQUEST_ENV];
					const resultPath = execOpts.env[SANDBOX_PROVIDER_RESULT_ENV];
					const env = {
						...execOpts.env,
						SMITHERS_SANDBOX_S3_BUCKET: bucket,
						SMITHERS_SANDBOX_S3_PREFIX: prefix,
						SMITHERS_SANDBOX_REQUEST_S3_KEY: requestPath ? transport.keyForPath(requestPath) : "",
						SMITHERS_SANDBOX_RESULT_S3_KEY: resultPath ? transport.keyForPath(resultPath) : "",
					};
					return runner.run(command, { env, timeoutMs: execOpts.timeoutMs, signal: execOpts.signal });
				},
				async destroy() {
					await runner.stop();
					await transport.deleteAll();
				},
			};
		},
	});
}

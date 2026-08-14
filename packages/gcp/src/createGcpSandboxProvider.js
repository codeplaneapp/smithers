import { SmithersError } from "@smthrs/errors/SmithersError";
import {
  createCommandSandboxProvider,
  SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH,
  SANDBOX_PROVIDER_REQUEST_ENV,
  SANDBOX_PROVIDER_RESULT_ENV,
} from "@smthrs/sandbox";
import { GCP_SANDBOX_PROVIDER_ID } from "./GCP_SANDBOX_PROVIDER_ID.js";
import { createGcpCloudRunJobsSandboxRunner } from "./createGcpCloudRunJobsSandboxRunner.js";
import { createGcpSandboxGcsTransport } from "./createGcpSandboxGcsTransport.js";

const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_COMMAND = "node /workspace/run-smithers-sandbox.js";

// Extra env the kit does NOT set: they tell the in-container entry which GCS
// objects hold the request/result bundles, so it round-trips through Cloud
// Storage rather than a shared filesystem.
const GCS_BUCKET_ENV = "SMITHERS_SANDBOX_GCS_BUCKET";
const GCS_PREFIX_ENV = "SMITHERS_SANDBOX_GCS_PREFIX";
const GCS_REQUEST_OBJECT_ENV = "SMITHERS_SANDBOX_REQUEST_GCS_OBJECT";
const GCS_RESULT_OBJECT_ENV = "SMITHERS_SANDBOX_RESULT_GCS_OBJECT";
// The GCS object holding the egress CA bundle the kit uploaded via
// uploadEgressCaToSession. Container-entry contract: when this is present the
// entry MUST download it from Cloud Storage and materialize it at the local
// path in NODE_EXTRA_CA_CERTS before running — that env points at a container
// path that does not exist until the object is fetched. Injected only when the
// request carries an inline egress CA (`egress.caCertPem`), mirroring the
// request/result object injection.
const GCS_CA_OBJECT_ENV = "SMITHERS_SANDBOX_CA_GCS_OBJECT";

/**
 * The workdir-absolute path the kit writes the inline egress CA to (via
 * uploadEgressCaToSession). Kept in sync with that helper so the transport keys
 * the CA object under the same path the container will read.
 *
 * @param {string} workdir
 * @returns {string}
 */
function caWorkspacePath(workdir) {
  return `${workdir.replace(/\/+$/g, "")}/${SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH.replace(/^\/+/g, "")}`;
}

/**
 * @param {string} provider
 * @param {import("./GcpSandboxProviderOptions.ts").GcpSandboxProviderOptions} options
 * @returns {{ projectId: string; location: string; bucket: string; jobName: string }}
 */
function requireOptions(provider, options) {
  const projectId = (options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? "").trim();
  const location = (options.location ?? "").trim();
  const bucket = (options.bucket ?? "").trim();
  const jobName = (options.jobName ?? "").trim();
  if (!projectId) {
    throw new SmithersError("INVALID_INPUT", "GCP sandbox provider requires a projectId (or GOOGLE_CLOUD_PROJECT).", {
      provider,
    });
  }
  if (!location) {
    throw new SmithersError("INVALID_INPUT", "GCP sandbox provider requires a location (Cloud Run region).", {
      provider,
    });
  }
  if (!bucket) {
    throw new SmithersError("INVALID_INPUT", "GCP sandbox provider requires a pre-existing Cloud Storage bucket.", {
      provider,
    });
  }
  if (!jobName) {
    throw new SmithersError("INVALID_INPUT", "GCP sandbox provider requires a jobName (Cloud Run Job).", { provider });
  }
  return { projectId, location, bucket, jobName };
}

/**
 * Resolve the Cloud Storage client, importing `@google-cloud/storage` lazily
 * when no double is injected.
 *
 * @param {string} provider
 * @param {import("./GcpSandboxProviderOptions.ts").GcpSandboxProviderOptions} options
 * @returns {Promise<import("./GcpSandboxProviderOptions.ts").GcpStorageClient>}
 */
async function resolveStorageClient(provider, options) {
  const injected = options.clients?.storage ?? options.client?.storage;
  if (injected) return injected;
  let mod;
  try {
    mod = await (options.importStorageSdk ? options.importStorageSdk() : import("@google-cloud/storage"));
  } catch (error) {
    throw new SmithersError(
      "SANDBOX_EXECUTION_FAILED",
      `GCP sandbox provider could not load @google-cloud/storage. Install it: npm i @google-cloud/storage. (${error instanceof Error ? error.message : String(error)})`,
      { provider },
    );
  }
  const Storage = mod.Storage;
  if (typeof Storage !== "function") {
    throw new SmithersError("SANDBOX_EXECUTION_FAILED", "@google-cloud/storage does not export Storage.", { provider });
  }
  return new Storage({ projectId: options.projectId, ...options.clientOptions?.storage });
}

/**
 * Resolve the Cloud Run v2 JobsClient, importing `@google-cloud/run` lazily
 * when no double is injected.
 *
 * @param {string} provider
 * @param {import("./GcpSandboxProviderOptions.ts").GcpSandboxProviderOptions} options
 * @returns {Promise<import("./GcpSandboxProviderOptions.ts").GcpRunJobsClient>}
 */
async function resolveRunClient(provider, options) {
  const injected = options.clients?.run ?? options.client?.run;
  if (injected) return injected;
  let mod;
  try {
    mod = await (options.importRunSdk ? options.importRunSdk() : import("@google-cloud/run"));
  } catch (error) {
    throw new SmithersError(
      "SANDBOX_EXECUTION_FAILED",
      `GCP sandbox provider could not load @google-cloud/run. Install it: npm i @google-cloud/run. (${error instanceof Error ? error.message : String(error)})`,
      { provider },
    );
  }
  const JobsClient = mod.JobsClient ?? mod.v2?.JobsClient;
  if (typeof JobsClient !== "function") {
    throw new SmithersError("SANDBOX_EXECUTION_FAILED", "@google-cloud/run does not export a v2 JobsClient.", {
      provider,
    });
  }
  return new JobsClient({ projectId: options.projectId, ...options.clientOptions?.run });
}

/**
 * Build a Smithers SandboxProvider that executes bundles on Cloud Run Jobs and
 * ships the request/result bundles through a Cloud Storage bucket (no shared
 * filesystem). Auth is Application Default Credentials.
 *
 * @param {import("./GcpSandboxProviderOptions.ts").GcpSandboxProviderOptions} [options]
 * @returns {import("@smthrs/sandbox").SandboxProvider}
 */
export function createGcpSandboxProvider(options = {}) {
  const id = (options.id ?? GCP_SANDBOX_PROVIDER_ID).trim() || GCP_SANDBOX_PROVIDER_ID;
  const workdir = options.workdir ?? DEFAULT_WORKDIR;

  return createCommandSandboxProvider({
    id,
    command: options.command ?? DEFAULT_COMMAND,
    workdir,
    env: options.env,
    cleanup: options.cleanup,
    createSession: async (request) => {
      const { projectId, location, bucket, jobName } = requireOptions(id, options);
      const [storage, run] = await Promise.all([resolveStorageClient(id, options), resolveRunClient(id, options)]);

      const remoteSandboxId = options.sandboxId?.(request) ?? `${request.runId}-${request.sandboxId}`;
      const transport = createGcpSandboxGcsTransport({
        storage,
        bucket,
        prefix: options.prefix ?? "smithers/sandbox",
        runId: request.runId,
        sandboxId: remoteSandboxId,
        provider: id,
      });
      const runner = createGcpCloudRunJobsSandboxRunner({
        jobsClient: run,
        projectId,
        location,
        jobName,
        createJob: options.createJob,
        image: options.image,
        timeoutSec: options.timeoutSec,
        provider: id,
      });

      // When the request ships an inline egress CA, the kit uploads it to a
      // GCS object keyed by its workdir path. Compute that object name so exec
      // can hand it to the container (NODE_EXTRA_CA_CERTS alone points at a
      // nonexistent local path). Only set when a CA was actually uploaded.
      const caCertPem = request.egress?.caCertPem;
      const caObjectName =
        typeof caCertPem === "string" && caCertPem.length > 0
          ? transport.objectNameFor(caWorkspacePath(workdir))
          : undefined;

      let destroyed = false;

      return {
        get remoteId() {
          return runner.remoteId;
        },
        async writeFile(path, content) {
          if (destroyed)
            throw new SmithersError("SANDBOX_EXECUTION_FAILED", `GCP sandbox "${remoteSandboxId}" is destroyed.`, {
              provider: id,
            });
          await transport.writeFile(path, content);
        },
        async readFile(path) {
          return await transport.readFile(path);
        },
        async exec(command, execOptions) {
          if (destroyed)
            throw new SmithersError("SANDBOX_EXECUTION_FAILED", `GCP sandbox "${remoteSandboxId}" is destroyed.`, {
              provider: id,
            });
          const requestPath = execOptions.env[SANDBOX_PROVIDER_REQUEST_ENV];
          const resultPath = execOptions.env[SANDBOX_PROVIDER_RESULT_ENV];
          const env = {
            ...execOptions.env,
            [GCS_BUCKET_ENV]: bucket,
            [GCS_PREFIX_ENV]: transport.prefix,
            ...(requestPath ? { [GCS_REQUEST_OBJECT_ENV]: transport.objectNameFor(requestPath) } : {}),
            ...(resultPath ? { [GCS_RESULT_OBJECT_ENV]: transport.objectNameFor(resultPath) } : {}),
            ...(caObjectName ? { [GCS_CA_OBJECT_ENV]: caObjectName } : {}),
          };
          return await runner.run({
            command,
            env,
            timeoutMs: execOptions.timeoutMs,
            signal: execOptions.signal,
          });
        },
        async destroy() {
          if (destroyed) return;
          destroyed = true;
          await options.onDestroy?.();
          await transport.deleteAll();
          await runner.deleteJob();
        },
      };
    },
  });
}

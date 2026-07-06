import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { AWS_SANDBOX_PROVIDER_ID } from "./AWS_SANDBOX_PROVIDER_ID.js";
import { scrubAwsSandboxSecrets } from "./scrubAwsSandboxSecrets.js";

/**
 * @param {string} path
 * @returns {string}
 */
function basename(path) {
	const clean = String(path).replace(/\/+$/g, "");
	const index = clean.lastIndexOf("/");
	return index < 0 ? clean : clean.slice(index + 1);
}

/**
 * Read an S3 GetObject `Body` (real SDK stream, mock string, or Uint8Array)
 * into a string.
 *
 * @param {unknown} body
 * @returns {Promise<string>}
 */
async function readBody(body) {
	if (body === undefined || body === null) return "";
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	const maybe = /** @type {{ transformToString?: () => Promise<string> }} */ (body);
	if (typeof maybe.transformToString === "function") return await maybe.transformToString();
	return String(body);
}

/**
 * Build the S3-backed file transport for one sandbox session. Every workdir
 * path maps to a single flat object key
 * `s3://<bucket>/smithers/sandbox/<runId>/<sandboxId>/<basename(path)>`. The
 * container round-trips the request/result JSON through the same keys.
 *
 * @param {{
 *   s3: { putObject: (input: Record<string, unknown>) => Promise<any>; getObject: (input: Record<string, unknown>) => Promise<any>; deleteObjects: (input: Record<string, unknown>) => Promise<any> };
 *   bucket: string;
 *   prefix: string;
 *   secrets?: string[];
 * }} config
 */
export function createAwsSandboxS3Transport(config) {
	const { s3, bucket, prefix } = config;
	const secrets = config.secrets ?? [];
	/** @type {Set<string>} */
	const writtenKeys = new Set();

	/**
	 * @param {string} path
	 * @returns {string}
	 */
	function keyForPath(path) {
		return `${prefix}/${basename(path)}`;
	}

	/**
	 * @param {string} operation
	 * @param {string} key
	 * @param {unknown} error
	 * @returns {never}
	 */
	function fail(operation, key, error) {
		const detail = scrubAwsSandboxSecrets(error instanceof Error ? error.message : String(error), secrets);
		throw new SmithersError(
			"SANDBOX_EXECUTION_FAILED",
			`AWS sandbox S3 ${operation} failed for s3://${bucket}/${key}: ${detail}`,
			{ provider: AWS_SANDBOX_PROVIDER_ID, bucket, key, operation },
		);
	}

	return {
		bucket,
		prefix,
		keyForPath,
		/** @returns {string[]} */
		writtenKeys() {
			return [...writtenKeys];
		},
		/**
		 * @param {string} path
		 * @param {string} content
		 * @returns {Promise<void>}
		 */
		async writeFile(path, content) {
			const key = keyForPath(path);
			try {
				await s3.putObject({ Bucket: bucket, Key: key, Body: content });
			} catch (error) {
				fail("upload", key, error);
			}
			writtenKeys.add(key);
		},
		/**
		 * @param {string} path
		 * @returns {Promise<string>}
		 */
		async readFile(path) {
			const key = keyForPath(path);
			try {
				const res = await s3.getObject({ Bucket: bucket, Key: key });
				return await readBody(/** @type {{ Body?: unknown }} */ (res)?.Body);
			} catch (error) {
				return fail("download", key, error);
			}
		},
		/**
		 * Delete every transient object this session wrote (request/result/CA).
		 * @returns {Promise<void>}
		 */
		async deleteAll() {
			if (writtenKeys.size === 0) return;
			const keys = [...writtenKeys];
			writtenKeys.clear();
			try {
				await s3.deleteObjects({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } });
			} catch {
				// Best-effort cleanup: a leftover object must never fail the run.
			}
		},
	};
}

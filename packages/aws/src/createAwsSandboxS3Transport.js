import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { AWS_SANDBOX_PROVIDER_ID } from "./AWS_SANDBOX_PROVIDER_ID.js";
import { scrubAwsSandboxSecrets } from "./scrubAwsSandboxSecrets.js";

/**
 * Reduce a workdir path to a workdir-relative path. Strips a leading `workdir`
 * prefix (and any leading slashes) so `/workspace/a/config.json` becomes
 * `a/config.json`. Paths outside the workdir keep their absolute tail with the
 * leading slash removed. This preserves the *full* relative path so distinct
 * files never collapse to a shared basename.
 *
 * @param {string} path
 * @param {string} workdir
 * @returns {string}
 */
function workdirRelative(path, workdir) {
  const p = String(path);
  const wd = String(workdir).replace(/\/+$/g, "");
  if (wd && (p === wd || p.startsWith(`${wd}/`))) {
    return p.slice(wd.length).replace(/^\/+/g, "");
  }
  return p.replace(/^\/+/g, "");
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
 * `s3://<bucket>/smithers/sandbox/<runId>/<sandboxId>/<encoded-relative-path>`,
 * where `<encoded-relative-path>` is the `encodeURIComponent` of the
 * workdir-relative path. Encoding the whole relative path (rather than just its
 * basename) keeps the mapping collision-free and reversible: two files that
 * share a basename in different directories — e.g. `/workspace/a/config.json`
 * and `/workspace/b/config.json` — map to distinct keys (`a%2Fconfig.json` vs
 * `b%2Fconfig.json`). The container round-trips the request/result JSON through
 * the same keys.
 *
 * @param {{
 *   s3: { putObject: (input: Record<string, unknown>) => Promise<any>; getObject: (input: Record<string, unknown>) => Promise<any>; deleteObjects: (input: Record<string, unknown>) => Promise<any> };
 *   bucket: string;
 *   prefix: string;
 *   workdir?: string;
 *   secrets?: string[];
 * }} config
 */
export function createAwsSandboxS3Transport(config) {
  const { s3, bucket, prefix } = config;
  const workdir = config.workdir ?? "/workspace";
  const secrets = config.secrets ?? [];
  /** @type {Set<string>} */
  const writtenKeys = new Set();
  // Every key this session touches — written (request/CA) AND read (result) —
  // so `cleanup: "destroy"` removes the container-authored result object too, not
  // just the keys we uploaded. The result JSON is fetched via `readFile` and is
  // never registered in `writtenKeys`, so it would otherwise leak past destroy.
  /** @type {Set<string>} */
  const touchedKeys = new Set();

  /**
   * Map a workdir path to its collision-free S3 object key.
   * @param {string} path
   * @returns {string}
   */
  function keyForPath(path) {
    return `${prefix}/${encodeURIComponent(workdirRelative(path, workdir))}`;
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
      touchedKeys.add(key);
    },
    /**
     * @param {string} path
     * @returns {Promise<string>}
     */
    async readFile(path) {
      const key = keyForPath(path);
      // Register the key we read so cleanup removes the result object (written by
      // the container, fetched here) even though we never uploaded it ourselves.
      touchedKeys.add(key);
      try {
        const res = await s3.getObject({ Bucket: bucket, Key: key });
        return await readBody(/** @type {{ Body?: unknown }} */ (res)?.Body);
      } catch (error) {
        return fail("download", key, error);
      }
    },
    /**
     * Delete every transient object this session touched (request/result/CA).
     * @returns {Promise<void>}
     */
    async deleteAll() {
      if (touchedKeys.size === 0) return;
      const keys = [...touchedKeys];
      try {
        const result = await s3.deleteObjects({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } });
        const errors = Array.isArray(result?.Errors) ? result.Errors : [];
        const failedKeys = new Set(errors.map((error) => error?.Key).filter((key) => typeof key === "string"));
        for (const key of keys) {
          if (failedKeys.has(key)) continue;
          writtenKeys.delete(key);
          touchedKeys.delete(key);
        }
        if (failedKeys.size > 0) {
          console.warn(
            `[smithers/aws] S3 cleanup left ${failedKeys.size} object(s) in s3://${bucket}/${prefix}; retry deleteAll()`,
          );
        }
      } catch (error) {
        // Best-effort cleanup: a leftover object must never fail the run.
        const detail = scrubAwsSandboxSecrets(error instanceof Error ? error.message : String(error), secrets);
        console.warn(`[smithers/aws] S3 cleanup failed for s3://${bucket}/${prefix}; retry deleteAll(): ${detail}`);
      }
    },
  };
}

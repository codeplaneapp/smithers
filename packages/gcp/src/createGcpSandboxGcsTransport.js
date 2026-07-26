import { GCP_SANDBOX_PROVIDER_ID } from "./GCP_SANDBOX_PROVIDER_ID.js";

/**
 * Key a workdir path to a stable, collision-free object suffix. The full path
 * (not just its basename) is preserved so two distinct paths that share a
 * basename map to distinct GCS objects. Each segment is percent-encoded so the
 * mapping is injective (unlike a lossy charset replace, where `a b` and `a_b`
 * would collide); empty and `.`/`..` segments are dropped.
 *
 * @param {string} path
 * @returns {string}
 */
function objectKeyFor(path) {
  const segments = String(path)
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .map((segment) => encodeURIComponent(segment));
  return segments.length > 0 ? segments.join("/") : "object";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function decodeDownloaded(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.toString("utf-8");
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}

/**
 * Build the Cloud Storage bundle transport a GCP sandbox session uses instead of
 * a shared filesystem. Every workdir-relative path maps to a deterministic
 * object under `<prefix>/<runId>/<sandboxId>/<sanitized-workdir-path>`; writes
 * upload, reads download, and destroy removes the transient objects.
 *
 * @param {{
 *   storage: import("./GcpSandboxProviderOptions.ts").GcpStorageClient;
 *   bucket: string;
 *   prefix: string;
 *   runId: string;
 *   sandboxId: string;
 *   provider?: string;
 * }} options
 */
export function createGcpSandboxGcsTransport(options) {
  const { storage, bucket, runId, sandboxId } = options;
  const provider = options.provider ?? GCP_SANDBOX_PROVIDER_ID;
  const prefix = String(options.prefix ?? "smithers/sandbox").replace(/\/+$/g, "");
  const keyPrefix = `${prefix}/${runId}/${sandboxId}`;
  /** @type {Map<string, string>} path -> objectName */
  const pathToObject = new Map();

  /**
   * @param {string} path
   * @returns {string}
   */
  function objectNameFor(path) {
    const existing = pathToObject.get(path);
    if (existing) return existing;
    const objectName = `${keyPrefix}/${objectKeyFor(path)}`;
    pathToObject.set(path, objectName);
    return objectName;
  }

  return {
    bucket,
    prefix,
    keyPrefix,
    objectNameFor,
    /** @returns {ReadonlyMap<string, string>} */
    get mapping() {
      return pathToObject;
    },
    /**
     * @param {string} path
     * @param {string} content
     * @returns {Promise<void>}
     */
    async writeFile(path, content) {
      const objectName = objectNameFor(path);
      await storage.bucket(bucket).file(objectName).save(content);
    },
    /**
     * @param {string} path
     * @returns {Promise<string>}
     */
    async readFile(path) {
      const objectName = objectNameFor(path);
      const downloaded = await storage.bucket(bucket).file(objectName).download();
      const payload = Array.isArray(downloaded) ? downloaded[0] : downloaded;
      return decodeDownloaded(payload);
    },
    /**
     * Delete every transient object this sandbox touched (request, result,
     * egress CA). Best-effort per object so one missing/already-deleted object
     * never blocks the rest.
     *
     * @returns {Promise<void>}
     */
    async deleteAll() {
      const objectNames = new Set(pathToObject.values());
      await Promise.all(
        [...objectNames].map(async (objectName) => {
          try {
            await storage.bucket(bucket).file(objectName).delete({ ignoreNotFound: true });
          } catch {
            // transient objects carry a short TTL; ignore delete races.
          }
        }),
      );
      pathToObject.clear();
    },
    provider,
  };
}

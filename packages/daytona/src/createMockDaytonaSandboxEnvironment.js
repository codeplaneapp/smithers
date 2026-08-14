const REQUEST_ENV = "SMITHERS_SANDBOX_REQUEST_PATH";
const RESULT_ENV = "SMITHERS_SANDBOX_RESULT_PATH";
const REQUEST_FILE_SUFFIX = ".smithers/sandbox-request.json";
const RESULT_FILE_SUFFIX = ".smithers/sandbox-result.json";

/**
 * In-memory Daytona SDK double implementing exactly the subset
 * `createDaytonaSandboxProvider` calls: `daytona.create`, `sandbox.fs.uploadFile
 * / downloadFile`, `sandbox.process.executeCommand`, and `daytona.delete`.
 *
 * The execute path parses the shipped request file, invokes `handler`, writes
 * the returned SandboxProviderResult JSON to the result file, and returns the
 * Daytona `{ exitCode, result }` shape. This is what lets CI run with ZERO
 * Daytona credentials.
 *
 * @param {(args: {
 *   command: string;
 *   request: Record<string, unknown>;
 *   files: Map<string, string>;
 *   env: Record<string, string>;
 * }) => import("@smthrs/sandbox").SandboxProviderResult | Promise<import("@smthrs/sandbox").SandboxProviderResult>} handler
 * @param {{
 *   failCreate?: boolean;
 *   failExec?: boolean;
 *   failUpload?: boolean;
 *   failDownload?: boolean;
 *   failDelete?: boolean;
 *   onCreate?: (options: unknown) => void;
 *   onDestroy?: () => void;
 * }} [faults]
 * @returns {import("./DaytonaSandboxProviderOptions.ts").DaytonaClientLike & {
 *   sandboxes: Map<string, unknown>;
 *   createOptions: unknown[];
 * }}
 */
export function createMockDaytonaSandboxEnvironment(handler, faults = {}) {
  /** @type {Map<string, any>} */
  const sandboxes = new Map();
  /** @type {unknown[]} */
  const createOptions = [];
  let counter = 0;

  return {
    sandboxes,
    createOptions,
    async create(options) {
      createOptions.push(options);
      faults.onCreate?.(options);
      if (faults.failCreate) {
        throw new Error("mock daytona create failed [DAYTONA_API_KEY=secret]");
      }
      const id = `daytona-mock-${counter++}`;
      /** @type {Map<string, string>} */
      const files = new Map();
      let destroyed = false;
      const sandbox = {
        id,
        files,
        state: "started",
        get destroyed() {
          return destroyed;
        },
        _markDestroyed() {
          destroyed = true;
        },
        async waitUntilStarted() {},
        fs: {
          async uploadFile(content, path) {
            if (destroyed) throw new Error(`mock daytona sandbox "${id}" is destroyed`);
            if (faults.failUpload) throw new Error("mock daytona uploadFile failed [DAYTONA_API_KEY=secret]");
            files.set(path, decode(content));
          },
          async downloadFile(path) {
            if (faults.failDownload) throw new Error("mock daytona downloadFile failed [DAYTONA_API_KEY=secret]");
            return Buffer.from(files.get(path) ?? "");
          },
        },
        process: {
          async executeCommand(command, _cwd, env = {}, _timeoutSecs) {
            if (destroyed) throw new Error(`mock daytona sandbox "${id}" is destroyed`);
            if (faults.failExec) throw new Error("mock daytona executeCommand failed [DAYTONA_API_KEY=secret]");
            const requestPath = env[REQUEST_ENV] ?? findBySuffix(files, REQUEST_FILE_SUFFIX);
            const request = JSON.parse((requestPath && files.get(requestPath)) ?? "{}");
            const result = await handler({ command, request, files, env });
            const resultPath =
              env[RESULT_ENV] ?? findBySuffix(files, RESULT_FILE_SUFFIX) ?? `/workspace/${RESULT_FILE_SUFFIX}`;
            files.set(resultPath, JSON.stringify(result));
            return { exitCode: 0, result: "" };
          },
        },
      };
      sandboxes.set(id, sandbox);
      return sandbox;
    },
    async delete(sandbox) {
      if (faults.failDelete) throw new Error("mock daytona delete failed [DAYTONA_API_KEY=secret]");
      const entry = sandbox && typeof sandbox.id === "string" ? sandboxes.get(sandbox.id) : undefined;
      entry?._markDestroyed();
      faults.onDestroy?.();
    },
  };
}

/**
 * @param {Uint8Array | Buffer | string} content
 * @returns {string}
 */
function decode(content) {
  if (typeof content === "string") return content;
  if (content instanceof Uint8Array) return new TextDecoder().decode(content);
  return String(content);
}

/**
 * @param {Map<string, string>} files
 * @param {string} suffix
 * @returns {string | undefined}
 */
function findBySuffix(files, suffix) {
  for (const path of files.keys()) {
    if (path.endsWith(suffix)) return path;
  }
  return undefined;
}

const REQUEST_ENV = "SMITHERS_SANDBOX_REQUEST_PATH";
const RESULT_ENV = "SMITHERS_SANDBOX_RESULT_PATH";

/**
 * In-memory double for the Microsandbox SDK subset used by the provider.
 * It models builder configuration, sticky start/connect, guest filesystem
 * operations, streaming exec, ephemeral cleanup, and typed not-found errors.
 *
 * @param {(args: {
 *   command: string;
 *   request: Record<string, unknown>;
 *   files: Map<string, string | Uint8Array>;
 *   env: Record<string, string>;
 * }) => import("@smithers-orchestrator/sandbox").SandboxProviderResult | Promise<import("@smithers-orchestrator/sandbox").SandboxProviderResult>} handler
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxMockFaults} [faults]
 * @returns {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSdkLike & {
 *   sandboxes: Map<string, any>;
 *   createConfigs: Record<string, unknown>[];
 * }}
 */
export function createMockMicrosandboxEnvironment(handler, faults = {}) {
	/** @type {Map<string, any>} */
	const sandboxes = new Map();
	/** @type {Record<string, unknown>[]} */
	const createConfigs = [];

	const Sandbox = {
		builder(name) {
			return createBuilder(name, sandboxes, createConfigs, handler, faults);
		},
		async get(name) {
			if (faults.failGet) throw new Error("mock microsandbox database failed");
			const sandbox = sandboxes.get(name);
			if (!sandbox) throw notFound(name);
			return createHandle(sandbox);
		},
		async remove(name) {
			if (faults.failRemove) throw new Error("mock microsandbox remove failed");
			const sandbox = sandboxes.get(name);
			if (!sandbox) throw notFound(name);
			if (sandbox.status === "running") {
				const error = new Error(`sandbox "${name}" is still running`);
				error.code = "sandboxStillRunning";
				throw error;
			}
			sandboxes.delete(name);
			faults.onRemove?.(name);
		},
	};

	return { Sandbox, sandboxes, createConfigs };
}

/**
 * @param {string} name
 * @param {Map<string, any>} sandboxes
 * @param {Record<string, unknown>[]} createConfigs
 * @param {Function} handler
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxMockFaults} faults
 */
function createBuilder(name, sandboxes, createConfigs, handler, faults) {
	const config = {
		name,
		ports: [],
		volumes: [],
		env: {},
		labels: {},
		scripts: {},
		ephemeral: false,
		detached: false,
		replace: false,
	};
	const builder = {
		image(value) { config.image = value; return this; },
		fromSnapshot(value) { config.snapshot = value; return this; },
		cpus(value) { config.cpus = value; return this; },
		maxCpus(value) { config.maxCpus = value; return this; },
		memory(value) { config.memoryMib = value; return this; },
		maxMemory(value) { config.maxMemoryMib = value; return this; },
		workdir(value) { config.workdir = value; return this; },
		security(value) { config.security = value; return this; },
		pullPolicy(value) { config.pullPolicy = value; return this; },
		disableNetwork() { config.networkDisabled = true; return this; },
		port(host, guest) { config.ports.push({ host, guest }); return this; },
		volume(guest, configure) {
			const mountConfig = { guest, readonly: false };
			const mount = {
				bind(host) { mountConfig.host = host; return this; },
				readonly() { mountConfig.readonly = true; return this; },
			};
			configure(mount);
			config.volumes.push(mountConfig);
			return this;
		},
		envs(values) { Object.assign(config.env, values); return this; },
		labels(values) { Object.assign(config.labels, values); return this; },
		scripts(values) { Object.assign(config.scripts, values); return this; },
		maxDuration(value) { config.maxDurationSecs = value; return this; },
		idleTimeout(value) { config.idleTimeoutSecs = value; return this; },
		ephemeral(value) { config.ephemeral = value; return this; },
		detached(value) { config.detached = value; return this; },
		replace() { config.replace = true; return this; },
		replaceWithTimeout(value) { config.replace = true; config.replaceTimeoutMs = value; return this; },
		async create() {
			if (faults.failCreate) throw new Error("mock microsandbox create failed [SERVICE_TOKEN=secret]");
			const existing = sandboxes.get(name);
			if (existing && !config.replace) {
				const error = new Error(`sandbox "${name}" already exists`);
				error.code = "sandboxAlreadyExists";
				throw error;
			}
			if (existing) {
				existing.status = "stopped";
				sandboxes.delete(name);
			}
			const snapshot = clone(config);
			createConfigs.push(snapshot);
			faults.onCreate?.(snapshot);
			const sandbox = createSandbox(name, config, sandboxes, handler, faults);
			sandboxes.set(name, sandbox);
			return sandbox;
		},
	};
	return builder;
}

/**
 * @param {string} name
 * @param {Record<string, any>} config
 * @param {Map<string, any>} sandboxes
 * @param {Function} handler
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxMockFaults} faults
 */
function createSandbox(name, config, sandboxes, handler, faults) {
	/** @type {Map<string, string | Uint8Array>} */
	const files = new Map();
	const directories = new Set(["/"]);
	const sandbox = {
		name,
		status: "running",
		files,
		directories,
		config: clone(config),
		detached: Boolean(config.detached),
		fs() {
			return {
				async write(path, data) {
					if (faults.failWrite) throw new Error("mock microsandbox fs write failed");
					files.set(path, typeof data === "string" ? data : new Uint8Array(data));
				},
				async readToString(path) {
					if (faults.failRead) throw new Error("mock microsandbox fs read failed");
					return decode(files.get(path));
				},
				async exists(path) {
					return directories.has(path) || files.has(path);
				},
				async mkdir(path) {
					directories.add(path);
				},
			};
		},
		async execStreamWith(cmd, configure) {
			if (faults.failExec) throw new Error("mock microsandbox exec failed [SERVICE_TOKEN=secret]");
			const execConfig = { cmd, args: [], cwd: "/", env: {}, timeoutMs: undefined };
			const execBuilder = {
				args(value) { execConfig.args = [...value]; return this; },
				cwd(value) { execConfig.cwd = value; return this; },
				envs(value) { Object.assign(execConfig.env, value); return this; },
				timeout(value) { execConfig.timeoutMs = value; return this; },
			};
			configure(execBuilder);
			faults.onExec?.(clone(execConfig));
			let killed = false;
			let releaseHang;
			const hang = faults.hangExec
				? new Promise((resolve) => { releaseHang = resolve; })
				: undefined;
			return {
				async collect() {
					if (hang) await hang;
					if (killed) return output(137, "", "killed");
					const requestPath = execConfig.env[REQUEST_ENV];
					const resultPath = execConfig.env[RESULT_ENV];
					const request = JSON.parse(decode(files.get(requestPath)) || "{}");
					const command = execConfig.args.at(-1) ?? cmd;
					const result = await handler({ command, request, files, env: { ...execConfig.env } });
					files.set(resultPath, JSON.stringify(result));
					return output(0, "", "");
				},
				async kill() {
					killed = true;
					releaseHang?.();
				},
			};
		},
		async stop() {
			if (faults.failStop) throw new Error("mock microsandbox stop failed");
			sandbox.status = "stopped";
			faults.onStop?.(name);
			if (config.ephemeral) sandboxes.delete(name);
		},
		async stopWithTimeout() {
			await this.stop();
		},
		async detach() {
			sandbox.detached = true;
		},
	};
	return sandbox;
}

/** @param {any} sandbox */
function createHandle(sandbox) {
	return {
		name: sandbox.name,
		get status() { return sandbox.status; },
		async connect() {
			if (sandbox.status !== "running") throw new Error(`sandbox "${sandbox.name}" is not running`);
			return sandbox;
		},
		async connectWithTimeout() {
			return this.connect();
		},
		async start() {
			sandbox.status = "running";
			sandbox.detached = false;
			return sandbox;
		},
		async startDetached() {
			sandbox.status = "running";
			sandbox.detached = true;
			return sandbox;
		},
	};
}

/** @param {number} code @param {string} stdout @param {string} stderr */
function output(code, stdout, stderr) {
	return { code, stdout: () => stdout, stderr: () => stderr };
}

/** @param {unknown} value */
function decode(value) {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	return "";
}

/** @param {string} name */
function notFound(name) {
	const error = new Error(`sandbox "${name}" was not found`);
	error.code = "sandboxNotFound";
	return error;
}

/** @param {unknown} value */
function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

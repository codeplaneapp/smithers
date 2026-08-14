import { SandboxProviderRequest, SandboxProvider, SandboxProviderResult } from '@smthrs/sandbox';

declare const CLOUDFLARE_SANDBOX_PROVIDER_ID: "cloudflare-sandbox";

type CloudflareSqliteDescriptor = {
	dialect: "sqlite";
	driver: "cloudflare-sqlite";
	queryAllRaw(statement: string, params?: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown>> | Promise<ReadonlyArray<Record<string, unknown>>>;
	queryValuesRaw?(statement: string, params?: ReadonlyArray<unknown>): ReadonlyArray<ReadonlyArray<unknown>> | Promise<ReadonlyArray<ReadonlyArray<unknown>>>;
	execute?(statement: string, params?: ReadonlyArray<unknown>): unknown | Promise<unknown>;
	supportsTransactions?: boolean;
	transaction?<T>(operation: () => T | Promise<T>): T | Promise<T>;
};

type CloudflareDurableObjectSqlStorage = {
	exec(statement: string, ...params: unknown[]): unknown;
};

type CloudflareDurableObjectStorage = {
	sql: CloudflareDurableObjectSqlStorage;
	transaction?<T>(operation: () => T | Promise<T>): T | Promise<T>;
};

declare function createCloudflareDurableObjectSqliteDescriptor(
	storage: CloudflareDurableObjectStorage | CloudflareDurableObjectSqlStorage,
): CloudflareSqliteDescriptor;

type CloudflareD1Database = {
	prepare(statement: string): {
		bind(...params: unknown[]): {
			all(): Promise<{ results?: Record<string, unknown>[] }>;
			raw?(): Promise<unknown[][]>;
			run(): Promise<unknown>;
		};
	};
};

declare function createCloudflareD1SqliteDescriptor(database: CloudflareD1Database): CloudflareSqliteDescriptor;

type CloudflareSandboxProviderOptions = {
	binding?: unknown | ((request: SandboxProviderRequest) => unknown);
	getSandbox?: (binding: unknown, sandboxId: string, options?: Record<string, unknown>) => any;
	id?: string;
	sandboxId?: (request: SandboxProviderRequest) => string;
	sandboxOptions?: Record<string, unknown>;
	keepAlive?: boolean;
	sleepAfter?: string | number;
	workdir?: string;
	command?: string;
	env?: Record<string, string>;
	setupFiles?: Record<string, { content: string; encoding?: "utf-8" | "base64" }>;
	execution?: "exec" | "process";
	cleanup?: "destroy" | "keep";
	importCloudflareSandbox?: () => Promise<{ getSandbox?: unknown }>;
};

declare function createCloudflareSandboxProvider(options?: CloudflareSandboxProviderOptions): SandboxProvider;

declare function createMockCloudflareSandboxEnvironment(
	handler: (args: {
		command: string;
		request: { runId: string; sandboxId: string; input?: unknown; config?: unknown };
		files: Map<string, string>;
	}) => SandboxProviderResult | Promise<SandboxProviderResult>,
): {
	binding: unknown;
	getSandbox: (binding: unknown, sandboxId: string, options?: Record<string, unknown>) => any;
	sandboxes: Map<string, any>;
};

export { CLOUDFLARE_SANDBOX_PROVIDER_ID, type CloudflareD1Database, type CloudflareDurableObjectSqlStorage, type CloudflareDurableObjectStorage, type CloudflareSandboxProviderOptions, type CloudflareSqliteDescriptor, createCloudflareD1SqliteDescriptor, createCloudflareDurableObjectSqliteDescriptor, createCloudflareSandboxProvider, createMockCloudflareSandboxEnvironment };

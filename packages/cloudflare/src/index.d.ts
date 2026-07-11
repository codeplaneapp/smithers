import type { SandboxProvider, SandboxProviderRequest, SandboxProviderResult } from "@smithers-orchestrator/sandbox";

export const CLOUDFLARE_SANDBOX_PROVIDER_ID: "cloudflare-sandbox";

export type CloudflareSqliteDescriptor = {
	dialect: "sqlite";
	driver: "cloudflare-sqlite";
	queryAllRaw(statement: string, params?: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown>> | Promise<ReadonlyArray<Record<string, unknown>>>;
	queryValuesRaw?(statement: string, params?: ReadonlyArray<unknown>): ReadonlyArray<ReadonlyArray<unknown>> | Promise<ReadonlyArray<ReadonlyArray<unknown>>>;
	execute?(statement: string, params?: ReadonlyArray<unknown>): unknown | Promise<unknown>;
	supportsTransactions?: boolean;
	transaction?<T>(operation: () => T | Promise<T>): T | Promise<T>;
};

export type CloudflareDurableObjectSqlStorage = {
	exec(statement: string, ...params: unknown[]): unknown;
};

export type CloudflareDurableObjectStorage = {
	sql: CloudflareDurableObjectSqlStorage;
	transaction?<T>(operation: () => T | Promise<T>): T | Promise<T>;
};

export function createCloudflareDurableObjectSqliteDescriptor(
	storage: CloudflareDurableObjectStorage | CloudflareDurableObjectSqlStorage,
): CloudflareSqliteDescriptor;

export type CloudflareD1Database = {
	prepare(statement: string): {
		bind(...params: unknown[]): {
			all(): Promise<{ results?: Record<string, unknown>[] }>;
			raw?(): Promise<unknown[][]>;
			run(): Promise<unknown>;
		};
	};
};

export function createCloudflareD1SqliteDescriptor(database: CloudflareD1Database): CloudflareSqliteDescriptor;

export type CloudflareSandboxProviderOptions = {
	binding?: unknown | ((request: SandboxProviderRequest) => unknown);
	getSandbox?: (binding: unknown, sandboxId: string, options?: Record<string, unknown>) => any;
	id?: string;
	sandboxId?: (request: SandboxProviderRequest) => string;
	sandboxOptions?: Record<string, unknown>;
	keepAlive?: boolean;
	workdir?: string;
	command?: string;
	env?: Record<string, string>;
	setupFiles?: Record<string, { content: string; encoding?: "utf-8" | "base64" }>;
	execution?: "exec" | "process";
	cleanup?: "destroy" | "keep";
	importCloudflareSandbox?: () => Promise<{ getSandbox?: unknown }>;
};

export function createCloudflareSandboxProvider(options?: CloudflareSandboxProviderOptions): SandboxProvider;

export function createMockCloudflareSandboxEnvironment(
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

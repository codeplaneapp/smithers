import type { SandboxProvider, SandboxProviderResult } from "@smthrs/sandbox";

export const DAYTONA_SANDBOX_PROVIDER_ID: "daytona-sandbox";

export type DaytonaClientOptions = {
	apiKey?: string;
	apiUrl?: string;
	target?: string;
};

export type DaytonaResources = {
	cpu?: number;
	memory?: number;
	disk?: number;
};

export type DaytonaCreateOptions = {
	image?: string;
	snapshot?: string;
	envVars?: Record<string, string>;
	labels?: Record<string, string>;
	ephemeral?: boolean;
	autoStopInterval?: number;
	resources?: DaytonaResources;
};

export type DaytonaSandboxLike = {
	id: string;
	fs: {
		uploadFile: (content: Uint8Array | Buffer, path: string) => Promise<unknown>;
		downloadFile: (path: string) => Promise<Uint8Array | Buffer | string>;
	};
	process: {
		executeCommand: (
			command: string,
			cwd?: string,
			env?: Record<string, string>,
			timeoutSecs?: number,
		) => Promise<{ exitCode?: number; result?: string }>;
	};
	waitUntilStarted?: () => Promise<unknown>;
	state?: string;
};

export type DaytonaClientLike = {
	create: (options?: DaytonaCreateOptions) => Promise<DaytonaSandboxLike>;
	delete: (sandbox: DaytonaSandboxLike) => Promise<unknown>;
};

export type DaytonaSandboxProviderOptions = {
	id?: string;
	command?: string;
	workdir?: string;
	env?: Record<string, string>;
	cleanup?: "destroy" | "keep";
	client?: DaytonaClientLike;
	importSdk?: () => Promise<unknown>;
	clientOptions?: DaytonaClientOptions;
	apiKey?: string;
	apiUrl?: string;
	target?: string;
	image?: string;
	snapshot?: string;
	labels?: Record<string, string>;
	resources?: DaytonaResources;
	ephemeral?: boolean;
	autoStopInterval?: number;
};

export function createDaytonaSandboxProvider(options?: DaytonaSandboxProviderOptions): SandboxProvider;

export function registerDaytonaSandboxProvider(options?: DaytonaSandboxProviderOptions): () => void;

export type DaytonaMockFaults = {
	failCreate?: boolean;
	failExec?: boolean;
	failUpload?: boolean;
	failDownload?: boolean;
	failDelete?: boolean;
	onCreate?: (options: unknown) => void;
	onDestroy?: () => void;
};

export function createMockDaytonaSandboxEnvironment(
	handler: (args: {
		command: string;
		request: Record<string, unknown>;
		files: Map<string, string>;
		env: Record<string, string>;
	}) => SandboxProviderResult | Promise<SandboxProviderResult>,
	faults?: DaytonaMockFaults,
): DaytonaClientLike & {
	sandboxes: Map<string, any>;
	createOptions: unknown[];
};

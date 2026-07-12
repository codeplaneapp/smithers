import type { OpenApiAuth } from "./OpenApiAuth.ts";

type OpenApiToolResponseExample = {
	status?: string | number;
	description?: string;
	value: unknown;
};

type OpenApiOperationCuration =
	| false
	| {
			include?: boolean;
			name?: string;
			description?: string;
			responseExamples?: OpenApiToolResponseExample[];
	  };

export type OpenApiToolsOptions = {
	/**
	 * Operator-pinned request base URL. Credentialed tools require this instead
	 * of trusting a spec-controlled servers[].url.
	 */
	baseUrl?: string;
	headers?: Record<string, string>;
	auth?: OpenApiAuth;
	/**
	 * Additional origins authorized as redirect destinations. Credentialed
	 * requests fail closed on every other cross-origin redirect.
	 */
	allowedRedirectOrigins?: string[];
	/**
	 * Compatibility alias for `allowedRedirectOrigins`. This is redirect-only
	 * and never authorizes a spec-controlled initial server.
	 */
	allowedOrigins?: string[];
	/**
	 * Permit private/special destinations for remote spec loads, redirect hops,
	 * and an unpinned credential-free spec server. Off by default; prefer an
	 * exact baseUrl for API requests. This cannot replace baseUrl when auth or
	 * headers are configured.
	 */
	allowPrivateNetwork?: boolean;
	/**
	 * Override Node/Bun DNS resolution used to reject spec/API hostnames whose
	 * A/AAAA answers include non-global addresses. Resolution failures, empty
	 * answers, and malformed or non-global answers are denied. Useful for
	 * controlled runtimes and deterministic tests.
	 */
	resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]>;
	/** Maximum number of redirect hops. Defaults to 5. */
	maxRedirects?: number;
	/** Maximum serialized request-body bytes. Defaults to 10 MiB; must be a non-negative safe integer. */
	maxRequestBytes?: number;
	/** Maximum decoded response bytes buffered by a generated tool. Defaults to 1 MiB; must be a non-negative safe integer. */
	maxResponseBytes?: number;
	/** Maximum bytes buffered while loading a remote OpenAPI spec. Defaults to 5 MiB; must be a non-negative safe integer. */
	maxSpecBytes?: number;
	/** Cancels remote spec loading. Per-tool execution uses the AI SDK abort signal. */
	signal?: AbortSignal;
	include?: string[];
	exclude?: string[];
	namePrefix?: string;
	operations?: Record<string, OpenApiOperationCuration>;
};

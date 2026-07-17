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
	baseUrl?: string;
	headers?: Record<string, string>;
	auth?: OpenApiAuth;
	/**
	 * Extra origins (e.g. "https://cdn.example.com") that redirects may be
	 * followed to. Redirect destinations are always validated against the
	 * origin of the request itself (the configured OpenAPI service); any hop
	 * to another origin is refused unless it is listed here, so the injected
	 * auth/API-key headers can never leak to an unexpected host.
	 */
	allowedRedirectOrigins?: string[];
	/**
	 * Maximum response body size in bytes. Both successful and error responses
	 * are bounded. Defaults to 1,048,576 bytes (1 MiB) and must be a positive
	 * safe integer.
	 */
	maxResponseBodyBytes?: number;
	include?: string[];
	exclude?: string[];
	namePrefix?: string;
	operations?: Record<string, OpenApiOperationCuration>;
};

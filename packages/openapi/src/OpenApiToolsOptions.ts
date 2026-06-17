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
	include?: string[];
	exclude?: string[];
	namePrefix?: string;
	operations?: Record<string, OpenApiOperationCuration>;
};

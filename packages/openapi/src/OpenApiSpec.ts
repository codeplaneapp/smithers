import type { ParameterObject } from "./ParameterObject.ts";
import type { PathItem } from "./PathItem.ts";
import type { RequestBodyObject } from "./RequestBodyObject.ts";
import type { SchemaObject } from "./SchemaObject.ts";

export type OpenApiSpec = {
	openapi: string;
	info: {
		title: string;
		version: string;
		description?: string;
	};
	servers?: Array<{
		url: string;
		description?: string;
		variables?: Record<
			string,
			{
				default: string;
				enum?: string[];
				description?: string;
			}
		>;
	}>;
	paths: Record<string, PathItem>;
	components?: {
		schemas?: Record<string, SchemaObject>;
		parameters?: Record<string, ParameterObject>;
		requestBodies?: Record<string, RequestBodyObject>;
	};
};

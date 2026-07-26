import type { RefObject } from "./RefObject.ts";
import type { SchemaObject } from "./SchemaObject.ts";

export type ParameterObject = {
	name: string;
	in: "query" | "header" | "path" | "cookie";
	description?: string;
	required?: boolean;
	schema?: SchemaObject | RefObject;
	deprecated?: boolean;
	/** Serialization style; defaults to `form` for query, `simple` otherwise. */
	style?: "matrix" | "label" | "form" | "simple" | "spaceDelimited" | "pipeDelimited" | "deepObject";
	/** Defaults to `true` for `style: form`, `false` otherwise. */
	explode?: boolean;
};

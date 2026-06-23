import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOpenApiDocument,
  toYaml,
  scalarToYaml,
  rpcPath,
  buildPath,
  errorSchema,
  successSchema,
  requestFrameSchema,
} from "../scripts/generate-openapi.ts";
import { GATEWAY_RPC_DEFINITIONS, GATEWAY_RPC_ERRORS, SMITHERS_API_VERSION } from "../src/rpc/index.ts";
import { GATEWAY_SCOPE_VALUES } from "../src/auth/scopes.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("generate-openapi helpers", () => {
  test("rpcPath returns the correct path for a definition", () => {
    const def = GATEWAY_RPC_DEFINITIONS[0];
    expect(rpcPath(def)).toBe(`/v1/rpc/${def.method}`);
    for (const d of GATEWAY_RPC_DEFINITIONS) {
      expect(rpcPath(d)).toBe(`/v1/rpc/${d.method}`);
    }
  });

  test("errorSchema produces a valid closed object referencing the definition errors", () => {
    for (const def of GATEWAY_RPC_DEFINITIONS) {
      const schema = errorSchema(def);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.ok.const).toBe(false);
      expect(schema.properties.apiVersion.const).toBe(SMITHERS_API_VERSION);
      expect(schema.properties.error.properties.code.enum).toEqual(def.errors);
      expect(schema.properties.error.properties.requiredScope.enum).toEqual(GATEWAY_SCOPE_VALUES);
    }
  });

  test("successSchema produces a valid closed object with the definition responseSchema", () => {
    for (const def of GATEWAY_RPC_DEFINITIONS) {
      const schema = successSchema(def);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.ok.const).toBe(true);
      expect(schema.properties.apiVersion.const).toBe(SMITHERS_API_VERSION);
      expect(schema.properties.payload).toBe(def.responseSchema);
    }
  });

  test("requestFrameSchema binds method and params from the definition", () => {
    for (const def of GATEWAY_RPC_DEFINITIONS) {
      const schema = requestFrameSchema(def);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.method.const).toBe(def.method);
      expect(schema.properties.params).toBe(def.requestSchema);
    }
  });

  test("buildPath emits a POST operation with correct operationId, security, and responses", () => {
    for (const def of GATEWAY_RPC_DEFINITIONS) {
      const path = buildPath(def) as { post: Record<string, unknown> };
      expect(path.post).toBeDefined();
      expect(path.post.operationId).toBe(def.method);
      expect(path.post.summary).toBe(def.title);
      expect((path.post.security as Array<{ bearerAuth: string[] }>)[0].bearerAuth).toEqual([def.requiredScope]);
      const responses = path.post.responses as Record<string, unknown>;
      expect(responses["200"]).toBeDefined();
      for (const code of def.errors) {
        const error = GATEWAY_RPC_ERRORS[code];
        const response = responses[String(error.httpStatus)] as
          | { description?: string; content?: { "application/json"?: { schema?: unknown } } }
          | undefined;
        expect(response, `${def.method} ${code}`).toBeDefined();
        expect(response?.description).toBeDefined();
        expect(response?.content?.["application/json"]?.schema).toEqual(errorSchema(def));
      }
    }
  });

  test("buildOpenApiDocument returns a valid OpenAPI 3.1.0 document covering all RPC methods", () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe(SMITHERS_API_VERSION);
    expect(doc.components.securitySchemes.bearerAuth).toBeDefined();
    expect(doc.components.schemas.GatewayScope).toBeDefined();
    expect(doc.components.schemas.GatewayRpcErrorCode).toBeDefined();
    // Every RPC definition has a corresponding path entry
    for (const def of GATEWAY_RPC_DEFINITIONS) {
      expect(doc.paths[`/v1/rpc/${def.method}`]).toBeDefined();
    }
    // Exactly as many paths as definitions
    expect(Object.keys(doc.paths).length).toBe(GATEWAY_RPC_DEFINITIONS.length);
  });
});

describe("scalarToYaml", () => {
  test("null renders as 'null'", () => {
    expect(scalarToYaml(null)).toBe("null");
  });

  test("booleans render as their string representations", () => {
    expect(scalarToYaml(true)).toBe("true");
    expect(scalarToYaml(false)).toBe("false");
  });

  test("numbers render as their string representations", () => {
    expect(scalarToYaml(42)).toBe("42");
    expect(scalarToYaml(3.14)).toBe("3.14");
  });

  test("safe strings render unquoted", () => {
    expect(scalarToYaml("hello")).toBe("hello");
    expect(scalarToYaml("application/json")).toBe("application/json");
    expect(scalarToYaml("some-value")).toBe("some-value");
  });

  test("reserved YAML words are quoted", () => {
    expect(scalarToYaml("true")).toBe('"true"');
    expect(scalarToYaml("false")).toBe('"false"');
    expect(scalarToYaml("null")).toBe('"null"');
  });

  test("strings with special characters are JSON-quoted", () => {
    expect(scalarToYaml("hello world")).toBe('"hello world"');
    expect(scalarToYaml("line1\nline2")).toBe('"line1\\nline2"');
  });
});

describe("toYaml", () => {
  test("renders an empty array as '[]'", () => {
    expect(toYaml([])).toBe("[]");
  });

  test("renders an empty object as '{}'", () => {
    expect(toYaml({})).toBe("{}");
  });

  test("renders a flat object with scalar values", () => {
    const result = toYaml({ a: "hello", b: 42, c: true });
    expect(result).toContain("a: hello");
    expect(result).toContain("b: 42");
    expect(result).toContain("c: true");
  });

  test("renders nested objects with correct indentation", () => {
    const result = toYaml({ outer: { inner: "val" } }, 0);
    expect(result).toContain("outer:");
    expect(result).toContain("inner: val");
  });

  test("renders arrays of scalars as YAML list items", () => {
    const result = toYaml(["a", "b", "c"], 0);
    expect(result).toContain("- a");
    expect(result).toContain("- b");
    expect(result).toContain("- c");
  });

  test("renders arrays of objects with block style", () => {
    const result = toYaml([{ x: 1 }, { x: 2 }], 0);
    expect(result).toContain("x: 1");
    expect(result).toContain("x: 2");
  });

  test("quotes object keys that contain characters outside the safe set", () => {
    const result = toYaml({ "x-custom header": "val" }, 0);
    expect(result).toContain('"x-custom header": val');
  });

  test("the full document serializes to a string that matches the committed openapi.yaml", () => {
    const committed = readFileSync(resolve(packageDir, "openapi.yaml"), "utf8");
    const generated = `${toYaml(buildOpenApiDocument())}\n`;
    expect(generated).toBe(committed);
  });
});

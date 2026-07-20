import { describe, expect, test } from "bun:test";
import { jsonSchemaToTypebox, jsonSchemaTypeToTypebox } from "../src/extension.js";

describe("jsonSchemaToTypebox", () => {
  test("maps object-typed params to a record instead of coercing to string (#223)", () => {
    // run_workflow.input is `{ type: "object" }`; the old converter fell through
    // to Type.String(), so Pi rejected object input as "must be string".
    const result = jsonSchemaToTypebox({
      properties: {
        input: { type: "object", additionalProperties: {} },
      },
      required: [],
    });

    expect(result.input.type).toBe("object");
  });

  test("preserves scalar, array, and required/optional shapes", () => {
    const result = jsonSchemaToTypebox({
      properties: {
        workflowId: { type: "string" },
        waitForStartMs: { type: "integer" },
        force: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["workflowId"],
    });

    expect(result.workflowId.type).toBe("string");
    expect(result.waitForStartMs.type).toBe("number");
    expect(result.force.type).toBe("boolean");
    expect(result.tags.type).toBe("array");
    expect(result.tags.items.type).toBe("string");
  });

  test("derives array item types instead of hardcoding string", () => {
    const result = jsonSchemaToTypebox({
      properties: {
        rows: { type: "array", items: { type: "object" } },
      },
      required: [],
    });

    expect(result.rows.type).toBe("array");
    expect(result.rows.items.type).toBe("object");
  });
});

describe("jsonSchemaTypeToTypebox", () => {
  test("maps each JSON Schema type, defaulting unknown nodes to Unknown", () => {
    expect(jsonSchemaTypeToTypebox({ type: "string" }).type).toBe("string");
    expect(jsonSchemaTypeToTypebox({ type: "integer" }).type).toBe("number");
    expect(jsonSchemaTypeToTypebox({ type: "boolean" }).type).toBe("boolean");
    expect(jsonSchemaTypeToTypebox({ type: "object" }).type).toBe("object");
    expect(jsonSchemaTypeToTypebox({ type: "array", items: { type: "string" } }).type).toBe("array");
    // Unknown TypeBox schema is the empty object `{}` (no `type`).
    expect(jsonSchemaTypeToTypebox(undefined).type).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Spec parsing and operation extraction tests
// ---------------------------------------------------------------------------
import { afterEach, describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { extractOperations, loadSpecSync } from "../src/spec-parser.js";
import { loadSpecEffect } from "../src/loadSpecEffect.js";
import { parseSpecText } from "../src/_specHelpers.js";
import { petStoreSpec, refSpec, noOperationIdSpec } from "./fixtures.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("loadSpecSync", () => {
    test("loads spec from object", () => {
        const spec = loadSpecSync(petStoreSpec);
        expect(spec.openapi).toBe("3.0.0");
        expect(spec.info.title).toBe("Pet Store");
    });
    test("loads spec from JSON string", () => {
        const json = JSON.stringify(petStoreSpec);
        const spec = loadSpecSync(json);
        expect(spec.openapi).toBe("3.0.0");
        expect(spec.info.title).toBe("Pet Store");
    });
    test("throws on invalid input", () => {
        expect(() => loadSpecSync("not valid json or yaml")).toThrow();
    });
});
describe("loadSpecEffect", () => {
    test("loads specs from object, raw text, file path, and URL", async () => {
        const fromObject = await Effect.runPromise(loadSpecEffect(petStoreSpec));
        expect(fromObject.info.title).toBe("Pet Store");

        const fromText = await Effect.runPromise(loadSpecEffect(JSON.stringify(petStoreSpec)));
        expect(fromText.openapi).toBe("3.0.0");

        const dir = mkdtempSync(join(tmpdir(), "openapi-spec-"));
        const filePath = join(dir, "openapi.json");
        writeFileSync(filePath, JSON.stringify(petStoreSpec), "utf8");
        const fromFile = await Effect.runPromise(loadSpecEffect(filePath));
        expect(fromFile.info.title).toBe("Pet Store");

        globalThis.fetch = async (url) => {
            expect(url).toBe("https://example.test/openapi.json");
            return new Response(JSON.stringify(petStoreSpec), { status: 200 });
        };
        const fromUrl = await Effect.runPromise(loadSpecEffect("https://example.test/openapi.json"));
        expect(fromUrl.paths["/pets"]).toBeDefined();
    });

    test("wraps URL and raw text loading failures", async () => {
        globalThis.fetch = async () => new Response("missing", { status: 404, statusText: "Not Found" });
        await expect(
            Effect.runPromise(loadSpecEffect("https://example.test/missing.json")),
        ).rejects.toThrow("openapi fetch spec");

        await expect(
            Effect.runPromise(loadSpecEffect("not valid json or yaml")),
        ).rejects.toThrow("openapi load spec");
    });

    test("parseSpecText reports YAML parser failures", () => {
        expect(() => parseSpecText("[unterminated")).toThrow("Failed to parse OpenAPI spec");
    });
});
describe("extractOperations", () => {
    test("extracts all operations from petstore spec", () => {
        const ops = extractOperations(petStoreSpec);
        expect(ops.length).toBe(4);
        const opIds = ops.map((o) => o.operationId);
        expect(opIds).toContain("listPets");
        expect(opIds).toContain("createPet");
        expect(opIds).toContain("getPet");
        expect(opIds).toContain("deletePet");
    });
    test("extracts correct method and path", () => {
        const ops = extractOperations(petStoreSpec);
        const listPets = ops.find((o) => o.operationId === "listPets");
        expect(listPets.method).toBe("get");
        expect(listPets.path).toBe("/pets");
        expect(listPets.summary).toBe("List all pets");
        const createPet = ops.find((o) => o.operationId === "createPet");
        expect(createPet.method).toBe("post");
        expect(createPet.path).toBe("/pets");
    });
    test("extracts parameters", () => {
        const ops = extractOperations(petStoreSpec);
        const listPets = ops.find((o) => o.operationId === "listPets");
        expect(listPets.parameters.length).toBe(2);
        expect(listPets.parameters[0].name).toBe("limit");
        expect(listPets.parameters[0].in).toBe("query");
    });
    test("extracts request body", () => {
        const ops = extractOperations(petStoreSpec);
        const createPet = ops.find((o) => o.operationId === "createPet");
        expect(createPet.requestBody).toBeDefined();
        const jsonSchema = createPet.requestBody?.content["application/json"]?.schema;
        expect(jsonSchema).toBeDefined();
        expect(createPet.requestBodyMediaType).toBe("application/json");
    });
    test("records fallback request body media type when JSON is absent", () => {
        const ops = extractOperations({
            openapi: "3.0.0",
            info: { title: "Forms", version: "1.0.0" },
            paths: {
                "/uploads": {
                    post: {
                        operationId: "uploadFile",
                        requestBody: {
                            required: true,
                            content: {
                                "multipart/form-data": {
                                    schema: {
                                        type: "object",
                                        required: ["file"],
                                        properties: {
                                            file: { type: "string", format: "binary" },
                                        },
                                    },
                                },
                            },
                        },
                        responses: { "200": { description: "ok" } },
                    },
                },
            },
        });
        expect(ops[0].requestBodyMediaType).toBe("multipart/form-data");
    });
    test("resolves $ref in request body", () => {
        const ops = extractOperations(refSpec);
        const createPet = ops.find((o) => o.operationId === "createPet");
        expect(createPet.requestBody).toBeDefined();
    });
    test("generates operationId when missing", () => {
        const ops = extractOperations(noOperationIdSpec);
        expect(ops.length).toBe(1);
        expect(ops[0].operationId).toBe("get_items_id");
    });
    test("extracts path parameters", () => {
        const ops = extractOperations(petStoreSpec);
        const getPet = ops.find((o) => o.operationId === "getPet");
        expect(getPet.parameters.length).toBe(1);
        expect(getPet.parameters[0].name).toBe("petId");
        expect(getPet.parameters[0].in).toBe("path");
        expect(getPet.parameters[0].required).toBe(true);
    });
    test("merges path-level parameters and lets operation-level parameters override matching keys", () => {
        const ops = extractOperations({
            openapi: "3.0.0",
            info: { title: "Path Params", version: "1.0.0" },
            paths: {
                "/orgs/{orgId}/pets": {
                    parameters: [
                        {
                            name: "orgId",
                            in: "path",
                            required: true,
                            description: "Path-level org id",
                            schema: { type: "string", pattern: "org_[0-9]+" },
                        },
                        {
                            name: "includeArchived",
                            in: "query",
                            description: "Shared archive filter",
                            schema: { type: "boolean", default: false },
                        },
                    ],
                    get: {
                        operationId: "listOrgPets",
                        parameters: [
                            {
                                name: "orgId",
                                in: "path",
                                required: true,
                                description: "Operation-level org id",
                                schema: { type: "string", minLength: 3 },
                            },
                            {
                                name: "limit",
                                in: "query",
                                schema: { type: "integer" },
                            },
                        ],
                        responses: { "200": { description: "ok" } },
                    },
                },
            },
        });

        const listOrgPets = ops.find((o) => o.operationId === "listOrgPets");
        expect(listOrgPets.parameters.map((p) => `${p.in}:${p.name}`)).toEqual([
            "query:includeArchived",
            "path:orgId",
            "query:limit",
        ]);
        expect(listOrgPets.parameters.find((p) => p.name === "orgId")).toMatchObject({
            description: "Operation-level org id",
            schema: { type: "string", minLength: 3 },
        });
    });
    test("handles empty paths", () => {
        const ops = extractOperations({
            openapi: "3.0.0",
            info: { title: "Empty", version: "1.0.0" },
            paths: {},
        });
        expect(ops.length).toBe(0);
    });
});

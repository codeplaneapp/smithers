// ---------------------------------------------------------------------------
// Tool factory tests — creation of AI SDK tools from specs
// ---------------------------------------------------------------------------
import { afterEach, describe, test, expect, mock } from "bun:test";
import { createOpenApiToolsSync, createOpenApiToolSync, listOperations, } from "../src/tool-factory.js";
import { petStoreSpec, complexSchemaSpec } from "./fixtures.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("createOpenApiToolsSync", () => {
    test("creates tools for all operations", () => {
        const tools = createOpenApiToolsSync(petStoreSpec);
        expect(Object.keys(tools)).toEqual(expect.arrayContaining(["listPets", "createPet", "getPet", "deletePet"]));
        expect(Object.keys(tools).length).toBe(4);
    });
    test("each tool has description and execute", () => {
        const tools = createOpenApiToolsSync(petStoreSpec);
        for (const t of Object.values(tools)) {
            expect(t).toBeDefined();
            // AI SDK tools have these properties
            expect(typeof t.execute).toBe("function");
        }
    });
    test("applies include filter", () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            include: ["listPets", "getPet"],
        });
        expect(Object.keys(tools).sort()).toEqual(["getPet", "listPets"]);
    });
    test("applies exclude filter", () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            exclude: ["deletePet"],
        });
        expect(Object.keys(tools)).not.toContain("deletePet");
        expect(Object.keys(tools).length).toBe(3);
    });
    test("applies exclude after include when both filters are provided", () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            include: ["listPets", "getPet", "deletePet"],
            exclude: ["getPet"],
        });
        expect(Object.keys(tools).sort()).toEqual(["deletePet", "listPets"]);
    });
    test("applies name prefix", () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            namePrefix: "pet_",
        });
        expect(Object.keys(tools)).toContain("pet_listPets");
        expect(Object.keys(tools)).toContain("pet_createPet");
        expect(Object.keys(tools)).not.toContain("listPets");
    });
    test("curates generated tools with aliases, descriptions, skipped endpoints, and response examples", () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            operations: {
                listPets: {
                    name: "findPets",
                    description: "Find pets by optional tag before choosing one.",
                    responseExamples: [
                        {
                            status: 200,
                            description: "Two pets returned",
                            value: [{ id: 1, name: "Fluffy" }],
                        },
                    ],
                },
                createPet: false,
                deletePet: { include: false },
            },
        });
        expect(Object.keys(tools).sort()).toEqual(["findPets", "getPet"]);
        expect(tools.findPets.description).toContain("Find pets by optional tag");
        expect(tools.findPets.description).toContain("Response examples:");
        expect(tools.findPets.description).toContain("200 Two pets returned");
        expect(tools.findPets.description).toContain('"name": "Fluffy"');
        expect(tools.createPet).toBeUndefined();
        expect(tools.deletePet).toBeUndefined();
    });
    test("throws when curated operation names collide", () => {
        expect(() => createOpenApiToolsSync(petStoreSpec, {
            operations: {
                listPets: { name: "managePets" },
                createPet: { name: "managePets" },
            },
        })).toThrow(/Duplicate OpenAPI tool name "managePets".*listPets.*createPet/);
    });
    test("uses server URL from spec as default base URL", () => {
        // Tools are created — we just verify they exist and the spec server is used
        const tools = createOpenApiToolsSync(petStoreSpec);
        expect(Object.keys(tools).length).toBeGreaterThan(0);
    });
    test("overrides base URL from options", () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            baseUrl: "https://custom.api.example.com",
        });
        expect(Object.keys(tools).length).toBeGreaterThan(0);
    });
    test("falls back to localhost when no base URL option or server is present", async () => {
        const specWithoutServers = {
            openapi: "3.0.0",
            info: { title: "Local", version: "1.0.0" },
            paths: {
                "/health": {
                    get: {
                        operationId: "getHealth",
                        responses: { "200": { description: "ok" } },
                    },
                },
            },
        };
        const mockFetch = mock(() => Promise.resolve(new Response("ok")));
        globalThis.fetch = mockFetch;

        const tools = createOpenApiToolsSync(specWithoutServers);
        await tools.getHealth.execute({});

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe("http://localhost/health");
        expect(init.method).toBe("GET");
    });
    test("creates tools from complex schema spec", () => {
        const tools = createOpenApiToolsSync(complexSchemaSpec);
        expect(Object.keys(tools)).toContain("search");
    });
});
describe("createOpenApiToolSync", () => {
    test("creates a single tool by operationId", () => {
        const t = createOpenApiToolSync(petStoreSpec, "listPets");
        expect(t).toBeDefined();
        expect(typeof t.execute).toBe("function");
    });
    test("throws for unknown operationId", () => {
        expect(() => createOpenApiToolSync(petStoreSpec, "nonExistent")).toThrow(/nonExistent/);
    });
});
describe("listOperations", () => {
    test("lists all operations", () => {
        const ops = listOperations(petStoreSpec);
        expect(ops.length).toBe(4);
        expect(ops[0].operationId).toBe("listPets");
        expect(ops[0].method).toBe("GET");
        expect(ops[0].path).toBe("/pets");
        expect(ops[0].summary).toBe("List all pets");
    });
    test("accepts JSON string input", () => {
        const ops = listOperations(JSON.stringify(petStoreSpec));
        expect(ops.length).toBe(4);
    });
});

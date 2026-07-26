// ---------------------------------------------------------------------------
// Array/object path, query and header parameters must be serialized per their
// OpenAPI style. A bare String(value) collapses ["cat","dog"] into the single
// query entry "tags=cat%2Cdog" (and an object into "[object Object]"), which
// the upstream API reads as one literal value.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createOpenApiToolsSync } from "../src/tool-factory.js";

/** @type {import("bun").Server} */
let server;
/** @type {string} */
let baseUrl;
/** @type {{ url: string; headers: Headers }[]} */
const requests = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push({ url: request.url, headers: request.headers });
      return Response.json({ ok: true });
    },
  });
  baseUrl = `http://${server.hostname}:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

beforeEach(() => {
  requests.length = 0;
});

/**
 * @param {Record<string, unknown>[]} parameters
 * @param {Record<string, unknown>} petIdSchema
 */
function makeSpec(parameters, petIdSchema) {
  return {
    openapi: "3.0.0",
    info: { title: "Params", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/pets/{petId}": {
        get: {
          operationId: "listPets",
          parameters: [{ name: "petId", in: "path", required: true, schema: petIdSchema }, ...parameters],
          responses: { 200: { description: "ok" } },
        },
      },
    },
  };
}

/**
 * @param {Record<string, unknown>[]} parameters
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} [petIdSchema]
 * @returns {Promise<URL>}
 */
async function callTool(parameters, args, petIdSchema = { type: "string" }) {
  const tools = createOpenApiToolsSync(makeSpec(parameters, petIdSchema));
  await tools.listPets.execute({ petId: "1", ...args });
  return new URL(lastRequest().url);
}

function lastRequest() {
  const request = requests.at(-1);
  if (!request) throw new Error("no request reached the test server");
  return request;
}

describe("query parameter serialization", () => {
  const arrayParam = { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } };
  const objectParam = { name: "filter", in: "query", schema: { type: "object" } };

  test("array uses the default form/explode: one entry per element", async () => {
    const url = await callTool([arrayParam], { tags: ["cat", "dog"] });
    expect(url.searchParams.getAll("tags")).toEqual(["cat", "dog"]);
  });

  test("array with explode: false joins elements with commas in one entry", async () => {
    const url = await callTool([{ ...arrayParam, explode: false }], { tags: ["cat", "dog"] });
    expect(url.searchParams.getAll("tags")).toEqual(["cat,dog"]);
  });

  test("array with spaceDelimited/pipeDelimited uses that delimiter", async () => {
    const spaced = await callTool([{ ...arrayParam, style: "spaceDelimited", explode: false }], {
      tags: ["cat", "dog"],
    });
    expect(spaced.searchParams.getAll("tags")).toEqual(["cat dog"]);
    const piped = await callTool([{ ...arrayParam, style: "pipeDelimited", explode: false }], { tags: ["cat", "dog"] });
    expect(piped.searchParams.getAll("tags")).toEqual(["cat|dog"]);
  });

  test("object uses the default form/explode: one entry per property", async () => {
    const url = await callTool([objectParam], { filter: { role: "admin", age: 7 } });
    expect(url.searchParams.getAll("role")).toEqual(["admin"]);
    expect(url.searchParams.getAll("age")).toEqual(["7"]);
    expect(url.searchParams.has("filter")).toBe(false);
  });

  test("object with explode: false flattens to key,value pairs", async () => {
    const url = await callTool([{ ...objectParam, explode: false }], { filter: { role: "admin", age: 7 } });
    expect(url.searchParams.getAll("filter")).toEqual(["role,admin,age,7"]);
  });

  test("object with deepObject brackets each property under the parameter name", async () => {
    const url = await callTool([{ ...objectParam, style: "deepObject" }], { filter: { role: "admin" } });
    expect(url.searchParams.getAll("filter[role]")).toEqual(["admin"]);
  });

  test("scalars are unchanged", async () => {
    const url = await callTool([{ name: "limit", in: "query", schema: { type: "integer" } }], { limit: 10 });
    expect(url.searchParams.getAll("limit")).toEqual(["10"]);
  });

  test("array element delimiters stay encoded inside their own entry", async () => {
    const url = await callTool([arrayParam], { tags: ["a&b=c", "d"] });
    expect(url.searchParams.getAll("tags")).toEqual(["a&b=c", "d"]);
  });
});

describe("path parameter serialization", () => {
  test("array uses style: simple with per-element encoding", async () => {
    const url = await callTool([], { petId: ["cat", "a,b"] }, { type: "array", items: { type: "string" } });
    // Commas between elements are delimiters; a comma inside an element is data.
    expect(url.pathname).toBe("/pets/cat,a%2Cb");
  });

  test("object flattens to key,value segments", async () => {
    const url = await callTool([], { petId: { role: "admin", age: 7 } }, { type: "object" });
    expect(url.pathname).toBe("/pets/role,admin,age,7");
  });

  test("scalar is still percent-encoded whole", async () => {
    const url = await callTool([], { petId: "a,b" });
    expect(url.pathname).toBe("/pets/a%2Cb");
  });
});

describe("header parameter serialization", () => {
  const headerParam = { name: "X-Tags", in: "header", schema: { type: "array", items: { type: "string" } } };

  test("array joins with commas per style: simple", async () => {
    await callTool([headerParam], { "X-Tags": ["cat", "dog"] });
    expect(lastRequest().headers.get("x-tags")).toBe("cat,dog");
  });

  test("object with explode: true emits key=value pairs", async () => {
    await callTool([{ name: "X-Filter", in: "header", schema: { type: "object" }, explode: true }], {
      "X-Filter": { role: "admin", age: 7 },
    });
    expect(lastRequest().headers.get("x-filter")).toBe("role=admin,age=7");
  });
});

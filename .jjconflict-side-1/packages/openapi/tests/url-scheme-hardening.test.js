import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createOpenApiToolsSync } from "../src/tool-factory.js";

let server;
let origin;
let requestCount;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      requestCount += 1;
      if (new URL(request.url).pathname === "/redirect-file") {
        return new Response(null, { status: 302, headers: { location: "file:///etc/hosts" } });
      }
      return Response.json({ ok: true });
    },
  });
  origin = `http://${server.hostname}:${server.port}`;
  requestCount = 0;
});

afterAll(() => server?.stop(true));

function spec(serverUrl) {
  return {
    openapi: "3.0.0",
    info: { title: "URL schemes", version: "1.0.0" },
    servers: [{ url: serverUrl }],
    paths: { "/health": { get: { operationId: "health", responses: { "200": { description: "ok" } } } } },
  };
}

describe("OpenAPI URL schemes", () => {
  test("returns a typed failure for non-HTTP server URLs", async () => {
    for (const serverUrl of ["file:///etc", "data:text/plain,secret", "ftp://example.test/api"]) {
      const result = await createOpenApiToolsSync(spec(serverUrl)).health.execute({});
      expect(result).toMatchObject({ error: true, status: "failed" });
      expect(result.message).toContain("does not support URL protocol");
      expect(result.message).not.toContain("secret");
    }
  });

  test("returns a typed failure for non-HTTP baseUrl options", async () => {
    for (const baseUrl of ["file:///etc", "data:text/plain,secret", "ftp://example.test/api"]) {
      const result = await createOpenApiToolsSync(spec(origin), { baseUrl }).health.execute({});
      expect(result).toMatchObject({ error: true, status: "failed" });
      expect(result.message).toContain("does not support URL protocol");
    }
  });

  test("preserves HTTP execution", async () => {
    await expect(createOpenApiToolsSync(spec(origin)).health.execute({})).resolves.toEqual({ ok: true });
  });

  test("rejects a non-HTTP redirect before following it", async () => {
    requestCount = 0;
    const result = await createOpenApiToolsSync({
      ...spec(origin),
      paths: { "/redirect-file": { get: { operationId: "redirectFile", responses: { "200": { description: "ok" } } } } },
    }).redirectFile.execute({});
    expect(result).toMatchObject({ error: true, status: "failed" });
    expect(result.message).toContain("does not support URL protocol");
    expect(requestCount).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";

import { createSmithersDataClient } from "../../src/data/createSmithersDataClient.ts";

/**
 * The data client builds the `/v1/api/runs` query string from the request
 * filter. A capturing fetch (returning a real, valid empty response) lets us
 * assert the request URL construction without a live gateway — this exercises
 * the client's builder, not a fabricated backend.
 */
function clientWithCapture() {
  const urls: string[] = [];
  const client = createSmithersDataClient({
    mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
    fetch: async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, urls };
}

describe("createSmithersDataClient listRuns query", () => {
  test("forwards the workflow filter into the /v1/api/runs query string", async () => {
    const { client, urls } = clientWithCapture();
    await client.api.listRuns({ filter: { workflow: "deploy", limit: 50 } });
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]);
    expect(url.pathname).toBe("/v1/api/runs");
    expect(url.searchParams.get("workflow")).toBe("deploy");
    expect(url.searchParams.get("limit")).toBe("50");
    client.close();
  });

  test("omits the workflow param when no workflow filter is set", async () => {
    const { client, urls } = clientWithCapture();
    await client.api.listRuns({ filter: { status: "finished", limit: 10 } });
    const url = new URL(urls[0]);
    expect(url.searchParams.has("workflow")).toBe(false);
    expect(url.searchParams.get("status")).toBe("finished");
    client.close();
  });

  test("forwards zero and non-zero offsets into the /v1/api/runs query string", async () => {
    const { client, urls } = clientWithCapture();
    await client.api.listRuns({ filter: { limit: 10, offset: 0 } });
    await client.api.listRuns({ filter: { limit: 10, offset: 10 } });
    expect(new URL(urls[0]).searchParams.get("offset")).toBe("0");
    expect(new URL(urls[1]).searchParams.get("offset")).toBe("10");
    client.close();
  });
});

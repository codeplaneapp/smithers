import { describe, expect, test } from "bun:test";
import { createGatewayUiApp } from "../src/gatewayUi/createGatewayUiApp.js";

describe("createGatewayUiApp", () => {
  test("returns 404 with x-smithers-ui-miss when resolveMatch is null", async () => {
    const app = createGatewayUiApp({
      resolveMatch: () => null,
      renderIndex: () => "<html></html>",
      renderAsset: async () => null,
    });
    const res = await app.request("http://localhost/anything");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-smithers-ui-miss")).toBe("1");
    expect(await res.text()).toBe("Not Found");
  });

  test("serves the rendered index HTML for a non-asset match", async () => {
    const match = { pathname: "/console", mountPath: "/console", assetPath: null, config: {} };
    const app = createGatewayUiApp({
      resolveMatch: () => match,
      renderIndex: (m) => `<title>${m.mountPath}</title>`,
      renderAsset: async () => null,
    });
    const res = await app.request("http://localhost/console");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("<title>/console</title>");
  });

  test("serves a rendered asset body with its content type", async () => {
    const match = {
      pathname: "/console/client.js",
      mountPath: "/console",
      assetPath: "client.js",
      config: {},
    };
    const app = createGatewayUiApp({
      resolveMatch: () => match,
      renderIndex: () => "",
      renderAsset: async () => ({ body: "console.log(1)", contentType: "text/javascript" }),
    });
    const res = await app.request("http://localhost/console/client.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("console.log(1)");
  });

  test("returns 404 when a matched asset renders null", async () => {
    const match = {
      pathname: "/console/missing.js",
      mountPath: "/console",
      assetPath: "missing.js",
      config: {},
    };
    const app = createGatewayUiApp({
      resolveMatch: () => match,
      renderIndex: () => "",
      renderAsset: async () => null,
    });
    const res = await app.request("http://localhost/console/missing.js");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayProvider, useSmithersGateway } from "../src/index.ts";

function Probe() {
  const client = useSmithersGateway();
  return createElement("span", null, client.baseUrl);
}

describe("SmithersGatewayProvider", () => {
  test("provides the configured Gateway client", () => {
    const client = new SmithersGatewayClient({ baseUrl: "http://gateway.test" });
    const html = renderToString(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe)),
    );
    expect(html).toContain("http://gateway.test");
  });
});

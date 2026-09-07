import { describe, expect, test } from "bun:test";
import { anthropicEndpointAllowed } from "../../src/server/proxy/anthropicEndpointAllowed.ts";

describe("anthropicEndpointAllowed", () => {
  test("allows POST /v1/messages, whatever case the method arrives in", () => {
    expect(anthropicEndpointAllowed("POST", "/v1/messages")).toBe(true);
    expect(anthropicEndpointAllowed("post", "/v1/messages")).toBe(true);
  });

  test("refuses the workspace-scoped object APIs the shared key can reach", () => {
    expect(anthropicEndpointAllowed("GET", "/v1/files")).toBe(false);
    expect(anthropicEndpointAllowed("DELETE", "/v1/files/foreign-file")).toBe(false);
    expect(anthropicEndpointAllowed("POST", "/v1/messages/batches")).toBe(false);
    expect(anthropicEndpointAllowed("GET", "/v1/messages/batches/msgbatch_foreign")).toBe(false);
    expect(anthropicEndpointAllowed("GET", "/v1/organizations/me")).toBe(false);
  });

  test("refuses other methods on the allowed path", () => {
    expect(anthropicEndpointAllowed("GET", "/v1/messages")).toBe(false);
    expect(anthropicEndpointAllowed("HEAD", "/v1/messages")).toBe(false);
    expect(anthropicEndpointAllowed("DELETE", "/v1/messages")).toBe(false);
  });

  test("matches the path literally, so near-misses fail closed", () => {
    expect(anthropicEndpointAllowed("POST", "/v1/messages/")).toBe(false);
    expect(anthropicEndpointAllowed("POST", "//v1/messages")).toBe(false);
    expect(anthropicEndpointAllowed("POST", "/v1/%6Dessages")).toBe(false);
    expect(anthropicEndpointAllowed("POST", "/V1/MESSAGES")).toBe(false);
    expect(anthropicEndpointAllowed("POST", "/v2/messages")).toBe(false);
  });
});

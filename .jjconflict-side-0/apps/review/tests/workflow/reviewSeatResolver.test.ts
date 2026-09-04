import { describe, expect, test } from "bun:test";
import * as Capability from "@smthrs/capability/Capability";
import { modelCallEnvelope, modelCallHosts } from "../../src/workflow/reviewSeatResolver.ts";

describe("review seat model grants", () => {
  test("uses the kernel's scheme-sensitive resource for a non-HTTPS provider", () => {
    const environment = { ANTHROPIC_BASE_URL: "http://LOCALHOST:5555/v1" };
    const requested = Capability.make("model:call", "http://localhost:5555/anthropic/test-model");
    const grants = modelCallEnvelope(environment);

    expect(modelCallHosts(environment)).toContain("http://localhost:5555");
    expect(grants.some((grant) => Capability.matches(grant, requested))).toBe(true);
    expect(
      grants.some((grant) => Capability.matches(grant, Capability.make("model:call", "localhost:5555/anthropic/test-model"))),
    ).toBe(false);
  });

  test("keeps HTTPS provider resources in the host-only compatibility form", () => {
    const environment = { ANTHROPIC_BASE_URL: "https://API.EXAMPLE.TEST/custom" };
    const requested = Capability.make("model:call", "api.example.test/anthropic/test-model");

    expect(modelCallHosts(environment)).toContain("api.example.test");
    expect(modelCallEnvelope(environment).some((grant) => Capability.matches(grant, requested))).toBe(true);
  });

  test("does not widen grants for an invalid provider URL", () => {
    expect(modelCallHosts({ ANTHROPIC_BASE_URL: "not a URL" })).toEqual([
      "api.anthropic.com",
      "api.openai.com",
      "openrouter.ai",
    ]);
  });
});

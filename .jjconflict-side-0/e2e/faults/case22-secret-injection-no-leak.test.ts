import { describe, expect, test } from "bun:test";
import { redactValue } from "@smithers-orchestrator/observability/_traceRedaction";

describe("case 22: Secret injection; no secrets in logs (redaction)", () => {
  test("trace redaction strips injected secrets from raw log strings", () => {
    const secret = "sk_case22_super_secret_1234567890";
    const raw = [
      "running command with injected env",
      `OPENAI_API_KEY=${secret}`,
      "Authorization: Bearer bearer_case22_secret_token",
      "password=hunter2",
    ].join("\n");

    const redacted = redactValue(raw);

    expect(redacted.applied).toBe(true);
    expect(redacted.ruleIds).toEqual(expect.arrayContaining(["api-key", "bearer-token", "secret-ish"]));
    expect(String(redacted.value)).not.toContain(secret);
    expect(String(redacted.value)).not.toContain("bearer_case22_secret_token");
    expect(String(redacted.value)).not.toContain("hunter2");
    expect(String(redacted.value)).toContain("[REDACTED_SECRET]");
  });

  test("trace redaction strips injected secrets from structured payloads without dropping safe fields", () => {
    const payload = {
      runId: "case22-run",
      nodeId: "secret-task",
      env: {
        OPENAI_API_KEY: "sk_case22_structured_1234567890",
        NORMAL_FLAG: "kept",
      },
      headers: {
        authorization: "Bearer structuredBearerToken",
        cookie: "session=case22-cookie-secret",
      },
      output: "completed without leaking secret=workspace-value",
    };

    const redacted = redactValue(payload);
    const serialized = JSON.stringify(redacted.value);

    expect(redacted.applied).toBe(true);
    expect(redacted.value).toMatchObject({
      runId: "case22-run",
      nodeId: "secret-task",
      env: { NORMAL_FLAG: "kept" },
    });
    expect(serialized).not.toContain("sk_case22_structured_1234567890");
    expect(serialized).not.toContain("structuredBearerToken");
    expect(serialized).not.toContain("case22-cookie-secret");
    expect(serialized).not.toContain("workspace-value");
  });
});

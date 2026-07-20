import { describe, expect, test } from "bun:test";
import { accountIdFromToken } from "../concierge/accountIdFromToken";
import { isAccessTokenExpired } from "../concierge/isAccessTokenExpired";
import { resolveConciergeModelConfig } from "../concierge/resolveConciergeModelConfig";
import { validateChatBody } from "../concierge/validateChatBody";

/** Build an unsigned JWT (`header.payload.sig`) — decodeJwtPayload never verifies. */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

const MAX_MESSAGES = 100;
const MAX_CONTENT_BYTES = 100 * 1024;
const MAX_SYSTEM_BYTES = 4 * 1024;

describe("validateChatBody", () => {
  test("accepts a well-formed body and drops the system field when blank", () => {
    const ok = validateChatBody({ messages: [{ role: "user", content: "hi" }], system: "   " });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("expected ok");
    expect(ok.body.messages).toHaveLength(1);
    expect(ok.body.system).toBeUndefined();
  });

  test("keeps a non-blank system string", () => {
    const ok = validateChatBody({ messages: [], system: "be terse" });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("expected ok");
    expect(ok.body.system).toBe("be terse");
  });

  test("clamps an oversized system prompt to the byte budget", () => {
    const ok = validateChatBody({ messages: [], system: "x".repeat(MAX_SYSTEM_BYTES + 500) });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("expected ok");
    expect(new TextEncoder().encode(ok.body.system).length).toBe(MAX_SYSTEM_BYTES);
  });

  test("rejects non-object bodies with 400", () => {
    for (const bad of [null, "str", 5, [] as unknown]) {
      const res = validateChatBody(bad);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected reject");
      expect(res.status).toBe(400);
    }
  });

  test("rejects a missing messages array with 400", () => {
    const res = validateChatBody({});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected reject");
    expect(res.status).toBe(400);
  });

  test("rejects too many messages with 413", () => {
    const messages = Array.from({ length: MAX_MESSAGES + 1 }, () => ({
      role: "user" as const,
      content: "x",
    }));
    const res = validateChatBody({ messages });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected reject");
    expect(res.status).toBe(413);
  });

  test("rejects oversized total content with 413", () => {
    const res = validateChatBody({
      messages: [{ role: "user", content: "a".repeat(MAX_CONTENT_BYTES + 1) }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected reject");
    expect(res.status).toBe(413);
  });

  test("rejects a malformed message and a non-string system with 400", () => {
    expect(validateChatBody({ messages: [{ role: "system", content: "x" }] }).ok).toBe(false);
    expect(validateChatBody({ messages: [{ role: "user" }] }).ok).toBe(false);
    const res = validateChatBody({ messages: [], system: 5 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected reject");
    expect(res.status).toBe(400);
  });
});

describe("resolveConciergeModelConfig", () => {
  test("prefers Cerebras when its key is set, with chat-completions defaults", () => {
    const cfg = resolveConciergeModelConfig({ CEREBRAS_API_KEY: "csk-1" } as NodeJS.ProcessEnv);
    expect(cfg.provider).toBe("cerebras");
    if (cfg.provider !== "cerebras") throw new Error("expected cerebras");
    expect(cfg.api).toBe("chat-completions");
    expect(cfg.model).toBe("gpt-oss-120b");
    expect(cfg.effort).toBe("none");
    expect(cfg.baseURL).toBe("https://api.cerebras.ai/v1");
    expect(cfg.usingSubscription).toBe(false);
  });

  test("honors Cerebras env overrides", () => {
    const cfg = resolveConciergeModelConfig({
      CEREBRAS_API_KEY: "csk-1",
      CONCIERGE_CEREBRAS_MODEL: "custom-model",
      CONCIERGE_CEREBRAS_REASONING_EFFORT: "low",
      CONCIERGE_CEREBRAS_BASE_URL: "http://localhost:9/v1",
    } as NodeJS.ProcessEnv);
    if (cfg.provider !== "cerebras") throw new Error("expected cerebras");
    expect(cfg.model).toBe("custom-model");
    expect(cfg.effort).toBe("low");
    expect(cfg.baseURL).toBe("http://localhost:9/v1");
  });

  test("falls back to the OpenAI/codex path when Cerebras key is blank", () => {
    const cfg = resolveConciergeModelConfig({ CEREBRAS_API_KEY: "   " } as NodeJS.ProcessEnv);
    expect(cfg.provider).toBe("fallback");
    if (cfg.provider !== "fallback") throw new Error("expected fallback");
    expect(cfg.model).toBe("gpt-5-mini");
    expect(cfg.effort).toBe("minimal");
  });

  test("fallback honors CONCIERGE_MODEL over the default", () => {
    const cfg = resolveConciergeModelConfig({ CONCIERGE_MODEL: "gpt-5-large" } as NodeJS.ProcessEnv);
    if (cfg.provider !== "fallback") throw new Error("expected fallback");
    expect(cfg.model).toBe("gpt-5-large");
  });
});

describe("codex token claims", () => {
  test("treats a token with no exp claim as expired", () => {
    expect(isAccessTokenExpired(makeJwt({}))).toBe(true);
    expect(isAccessTokenExpired("not-a-jwt")).toBe(true);
  });

  test("treats a far-future exp as live and a past exp as expired", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(isAccessTokenExpired(makeJwt({ exp: future }))).toBe(false);
    expect(isAccessTokenExpired(makeJwt({ exp: past }))).toBe(true);
  });

  test("treats an exp inside the skew window as expired", () => {
    const soon = Math.floor(Date.now() / 1000) + 30; // < 60s default skew
    expect(isAccessTokenExpired(makeJwt({ exp: soon }))).toBe(true);
  });

  test("extracts the chatgpt account id from the auth claim", () => {
    const token = makeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acc_123" },
    });
    expect(accountIdFromToken(token)).toBe("acc_123");
  });

  test("returns undefined when the account id is absent", () => {
    expect(accountIdFromToken(makeJwt({}))).toBeUndefined();
    expect(accountIdFromToken(makeJwt({ "https://api.openai.com/auth": {} }))).toBeUndefined();
  });
});

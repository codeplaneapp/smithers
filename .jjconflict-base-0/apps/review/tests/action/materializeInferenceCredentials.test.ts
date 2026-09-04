import { describe, expect, test } from "bun:test";
import { materializeInferenceCredentials } from "../../action/src/materializeInferenceCredentials.ts";

describe("materializeInferenceCredentials", () => {
  test("scrubs every raw credential the caller may have set", () => {
    const env: Record<string, string | undefined> = {
      CODEX_AUTH_JSON: "{}",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
      PATH: "/usr/bin",
    };

    const removed = materializeInferenceCredentials({ env });

    expect(new Set(removed)).toEqual(
      new Set(["CODEX_AUTH_JSON", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]),
    );
    expect("CODEX_AUTH_JSON" in env).toBe(false);
    expect("CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(false);
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    expect("OPENAI_API_KEY" in env).toBe(false);
    // Everything else is left exactly as it was.
    expect(env.PATH).toBe("/usr/bin");
  });

  test("reports nothing when the environment carries no raw credential", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    expect(materializeInferenceCredentials({ env })).toEqual([]);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

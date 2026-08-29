import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeInferenceCredentials } from "../../action/src/materializeInferenceCredentials.ts";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("materializeInferenceCredentials", () => {
  test("scrubs CODEX_AUTH_JSON from the env in every mode, keeps CLAUDE_CODE_OAUTH_TOKEN", () => {
    for (const mode of ["proxy", "claude-subscription"] as const) {
      const env: Record<string, string | undefined> = {
        CODEX_AUTH_JSON: '{"secret":"top"}',
        CLAUDE_CODE_OAUTH_TOKEN: "claude-tok",
      };
      const home = materializeInferenceCredentials({ mode, codexAuthJson: env.CODEX_AUTH_JSON, env });
      expect(home).toBeNull();
      expect("CODEX_AUTH_JSON" in env).toBe(false);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-tok");
    }
  });

  test("scrubs a whitespace-only CODEX_AUTH_JSON too", () => {
    const env: Record<string, string | undefined> = { CODEX_AUTH_JSON: "   " };
    materializeInferenceCredentials({ mode: "proxy", codexAuthJson: env.CODEX_AUTH_JSON, env });
    expect("CODEX_AUTH_JSON" in env).toBe(false);
  });

  test("codex mode materializes auth.json (0600) into an isolated CODEX_HOME and scrubs the env var", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "runner-temp-"));
    tempDirs.push(runnerTemp);
    const secret = '{"tokens":{"access":"abc"}}';
    const env: Record<string, string | undefined> = { CODEX_AUTH_JSON: secret, RUNNER_TEMP: runnerTemp };

    const codexHome = materializeInferenceCredentials({ mode: "codex-subscription", codexAuthJson: secret, env });

    expect(codexHome).toBe(join(runnerTemp, ".smithers-codex-home"));
    // codex-subscription mode always returns a path (asserted non-null above).
    expect(env.CODEX_HOME).toBe(codexHome!);
    // The secret is on disk for the codex CLI, but no longer in the environment
    // the agent subprocesses inherit.
    expect("CODEX_AUTH_JSON" in env).toBe(false);
    const authPath = join(codexHome!, "auth.json");
    expect(readFileSync(authPath, "utf8")).toBe(secret);
    // 0600: owner-only, so a same-user process needs the path — not readable via env.
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  test("codex mode honors an explicit CODEX_HOME", () => {
    const explicit = mkdtempSync(join(tmpdir(), "codex-home-"));
    tempDirs.push(explicit);
    const env: Record<string, string | undefined> = { CODEX_AUTH_JSON: "{}", CODEX_HOME: explicit };
    const codexHome = materializeInferenceCredentials({ mode: "codex-subscription", codexAuthJson: "{}", env });
    expect(codexHome).toBe(explicit);
    expect(readFileSync(join(explicit, "auth.json"), "utf8")).toBe("{}");
  });
});

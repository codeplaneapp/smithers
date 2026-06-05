import { describe, expect, test } from "bun:test";
import { AntigravityAgent } from "../src/AntigravityAgent.js";

const INVALID_AGY_FLAGS = [
  "--debug",
  "--output-format",
  "--include-directories",
  "--resume",
  "--list-sessions",
  "--screen-reader",
  "--extensions",
  "--list-extensions",
  "--delete-session",
  "--prompt",
];

async function buildAntigravityCommand(agent, options = {}) {
  return agent.buildCommand({
    prompt: "say ok",
    systemPrompt: "system",
    cwd: "/tmp/project",
    options,
  });
}

describe("AntigravityAgent command surface", () => {
  test("uses current agy non-interactive flags and never emits removed flags", async () => {
    const spec = await buildAntigravityCommand(new AntigravityAgent({
      model: "gemini-3.1-pro",
      includeDirectories: ["/tmp/project", "/tmp/shared"],
      conversation: "conv-123",
      continue: true,
      configDir: "/tmp/agy-config",
      apiKey: "google-key",
    }));

    expect(spec.command).toBe("agy");
    expect(spec.outputFormat).toBe("text");
    expect(spec.args).toContain("--cwd");
    expect(spec.args).toContain("/tmp/project");
    expect(spec.args).toContain("-p");
    expect(spec.args).toContain("--add-dir");
    expect(spec.args).toContain("/tmp/shared");
    expect(spec.args).toContain("--conversation");
    expect(spec.args).toContain("conv-123");
    expect(spec.args).toContain("--continue");
    expect(spec.args).toContain("--gemini_dir");
    expect(spec.env).toMatchObject({
      GEMINI_DIR: "/tmp/agy-config",
      GEMINI_API_KEY: "google-key",
    });
    for (const flag of INVALID_AGY_FLAGS) {
      expect(spec.args).not.toContain(flag);
    }
  });

  test("maps per-call resumeSession to --conversation", async () => {
    const spec = await buildAntigravityCommand(new AntigravityAgent({
      resume: "constructor-conversation",
    }), {
      resumeSession: "call-conversation",
    });

    const index = spec.args.indexOf("--conversation");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(spec.args[index + 1]).toBe("call-conversation");
    expect(spec.args).not.toContain("--resume");
  });

  test("fails fast for options that would emit removed agy flags", async () => {
    const cases = [
      ["debug", { debug: true }, "--debug"],
      ["screenReader", { screenReader: true }, "--screen-reader"],
      ["outputFormat", { outputFormat: "stream-json" }, "--output-format"],
      ["listSessions", { listSessions: true }, "--list-sessions"],
      ["deleteSession", { deleteSession: "conv-1" }, "--delete-session"],
      ["extensions", { extensions: ["old-extension"] }, "--extensions"],
      ["listExtensions", { listExtensions: true }, "--list-extensions"],
    ];

    for (const [name, opts, flag] of cases) {
      await expect(buildAntigravityCommand(new AntigravityAgent(opts))).rejects.toMatchObject({
        code: "AGENT_CONFIG_INVALID",
        details: {
          option: name,
          flag,
          failureRetryable: false,
        },
      });
    }
  });
});

// Self-contained agent providers for the docs-driven-development pack.
//
// The docs-driven-development workflow imports this module from the local ddd lib
// — i.e. from here — instead of the repo's `../agents`. Importing from the
// host repo's bespoke `.smithers/agents.ts` made the pack non-portable: a
// target repo whose agents.ts exports a different shape (e.g. multi's
// `codexMini`/`codexGoal`, or a repo with no `providers` export at all) broke
// every DDD workflow at import time.
//
// DDD owns its role chains here, under lib/ddd/, so the pack travels without a
// dependency on the host repo's agents.ts. Codex 5.6 is always first: Sol for
// planning/review, Luna for research and every implementation, and Terra for
// routine validation. Claude and Kimi remain dormant as no-Codex fallbacks.
import { accessSync, constants } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { ClaudeCodeAgent, CodexAgent, KimiAgent, type AgentLike } from "smithers-orchestrator";

function codexFirst(options: ConstructorParameters<typeof CodexAgent>[0], fallbacks: AgentLike[] = []): AgentLike[] {
  return [new CodexAgent(options), ...fallbacks];
}

// Honor the e2e harness's fake-agent PATH override the same way the seeded
// agents.ts does, so DDD tests can run without real CLIs on CI.
const testAgentPath = process.env.SMITHERS_TEST_AGENT_PATH?.trim();
const testAgentEnv = testAgentPath ? { PATH: testAgentPath } : undefined;

function commandExists(command: string): boolean {
  const searchPath = testAgentPath || process.env.PATH || "";
  const extensions =
    process.platform === "win32" && extname(command) === ""
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  return searchPath.split(delimiter).some((directory) =>
    extensions.some((extension) => {
      try {
        accessSync(join(directory, `${command}${extension}`), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

const hasKimi = commandExists("kimi");
const claudeSmartFallback = new ClaudeCodeAgent({ model: "claude-fable-5", env: testAgentEnv });
const claudeImplementationFallback = new ClaudeCodeAgent({ model: "claude-sonnet-5", env: testAgentEnv });
const kimiFallback = new KimiAgent({ model: "kimi-k2.7-code", env: testAgentEnv });

const sol = codexFirst(
  {
    model: "gpt-5.6-sol",
    config: { model_reasoning_effort: "xhigh" },
    skipGitRepoCheck: true,
    env: testAgentEnv,
  },
  [claudeSmartFallback, ...(hasKimi ? [kimiFallback] : [])],
);
const terra = codexFirst(
  {
    model: "gpt-5.6-terra",
    config: { model_reasoning_effort: "medium" },
    skipGitRepoCheck: true,
    env: testAgentEnv,
  },
  [claudeImplementationFallback, ...(hasKimi ? [kimiFallback] : [])],
);
const luna = codexFirst(
  {
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    skipGitRepoCheck: true,
    env: testAgentEnv,
  },
  [claudeImplementationFallback, ...(hasKimi ? [kimiFallback] : [])],
);

export const providers = {
  sol,
  terra,
  luna,
  // Compatibility aliases for installed DDD packs and their fake-agent e2e
  // fixtures. Despite the legacy names, every chain is Codex-first.
  claude: sol,
  claudeSonnet: luna,
  codex: luna,
} as const;

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseCliAgent } from "../src/BaseCliAgent/index.js";
import { makeFakeNodeCli, prependPath } from "./fake-cli.js";

const PARENT_SECRET = "SMITHERS_BASE_CLI_PARENT_SECRET_SENTINEL";
const originalParentSecret = process.env[PARENT_SECRET];
const originalPath = process.env.PATH ?? "";

afterEach(() => {
  if (originalParentSecret === undefined) {
    delete process.env[PARENT_SECRET];
  } else {
    process.env[PARENT_SECRET] = originalParentSecret;
  }
});

const probeObjectScript = `
const result = {
  parentSecret: process.env.${PARENT_SECRET} ?? null,
  agentOnly: process.env.AGENT_ONLY ?? null,
  taskRunId: process.env.SMITHERS_RUN_ID ?? null,
  taskAttempt: process.env.SMITHERS_ATTEMPT ?? null,
  shared: process.env.SHARED ?? null,
  commandOnly: process.env.COMMAND_ONLY ?? null,
};
`;

const generateProbeScript = `${probeObjectScript}\nprocess.stdout.write(JSON.stringify(result));`;

class GenerateEnvProbeAgent extends BaseCliAgent {
  /** @param {boolean | undefined} inheritEnv */
  constructor(inheritEnv) {
    super({
      id: "generate-env-probe",
      ...(inheritEnv === undefined ? {} : { inheritEnv }),
      env: {
        AGENT_ONLY: "agent",
        SHARED: "agent",
        SMITHERS_RUN_ID: "agent",
      },
    });
  }

  async buildCommand() {
    return {
      command: process.execPath,
      args: ["-e", generateProbeScript],
      outputFormat: "text",
      env: {
        COMMAND_ONLY: "command",
        SHARED: "command",
        SMITHERS_ATTEMPT: "command",
      },
    };
  }
}

class PreflightEnvProbeAgent extends BaseCliAgent {
  /**
   * @param {boolean | undefined} inheritEnv
   * @param {string} path
   * @param {string} dumpFile
   */
  constructor(inheritEnv, path, dumpFile) {
    super({
      id: "preflight-env-probe",
      ...(inheritEnv === undefined ? {} : { inheritEnv }),
      env: {
        PATH: path,
        PREFLIGHT_ENV_DUMP: dumpFile,
        ANTHROPIC_API_KEY: "",
        AGENT_ONLY: "agent",
        SHARED: "agent",
        SMITHERS_RUN_ID: "agent",
      },
    });
  }

  async buildCommand() {
    return {
      command: "claude",
      args: [],
      outputFormat: "text",
      env: {
        COMMAND_ONLY: "command",
        SHARED: "command",
        SMITHERS_ATTEMPT: "command",
      },
    };
  }
}

function expectedProbe(parentSecret) {
  return {
    parentSecret,
    agentOnly: "agent",
    taskRunId: "task",
    taskAttempt: "command",
    shared: "command",
    commandOnly: "command",
  };
}

describe("BaseCliAgent inheritEnv", () => {
  test("generate defaults to inheriting the parent and can omit it without changing env precedence", async () => {
    process.env[PARENT_SECRET] = "parent-secret";
    const options = {
      prompt: "probe",
      taskContext: { runId: "task", attempt: 2 },
    };

    const inherited = await new GenerateEnvProbeAgent(undefined).generate(options);
    expect(JSON.parse(inherited.text)).toEqual(expectedProbe("parent-secret"));

    const isolated = await new GenerateEnvProbeAgent(false).generate(options);
    expect(JSON.parse(isolated.text)).toEqual(expectedProbe(null));
  });

  test("preflight defaults to inheriting the parent and can omit it without changing env precedence", async () => {
    process.env[PARENT_SECRET] = "parent-secret";
    const dir = await mkdtemp(join(tmpdir(), "smithers-base-cli-env-"));
    const inheritedDump = join(dir, "inherited.json");
    const isolatedDump = join(dir, "isolated.json");
    const fake = await makeFakeNodeCli(
      dir,
      "claude",
      [
        'const fs = require("node:fs");',
        probeObjectScript,
        'fs.writeFileSync(process.env.PREFLIGHT_ENV_DUMP, JSON.stringify(result), "utf8");',
        'process.stdout.write(JSON.stringify({ loggedIn: true }) + "\\n");',
      ].join("\n"),
    );
    const path = prependPath(fake.dir, originalPath);
    const options = {
      rootDir: process.cwd(),
      taskContext: { runId: "task", attempt: 2 },
    };

    try {
      await new PreflightEnvProbeAgent(undefined, path, inheritedDump).preflight(options);
      expect(JSON.parse(await readFile(inheritedDump, "utf8"))).toEqual(expectedProbe("parent-secret"));

      await new PreflightEnvProbeAgent(false, path, isolatedDump).preflight(options);
      expect(JSON.parse(await readFile(isolatedDump, "utf8"))).toEqual(expectedProbe(null));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

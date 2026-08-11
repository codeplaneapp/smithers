import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { runCommandEffect } from "../../src/BaseCliAgent/runCommandEffect.js";

const [agentPidFile, spawnedPidFile] = process.argv.slice(2);

await Effect.runPromise(
  runCommandEffect(
    process.execPath,
    [
      "-e",
      `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        writeFileSync(process.env.SMITHERS_TEST_AGENT_PIDS, process.pid + ":" + child.pid);
        setInterval(() => {}, 1000);
      `,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, SMITHERS_TEST_AGENT_PIDS: agentPidFile },
      onProcess: ({ phase, pid }) => {
        if (phase === "started" && typeof pid === "number") writeFileSync(spawnedPidFile, String(pid));
      },
    },
  ),
);

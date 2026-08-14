import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { runCommandEffect } from "../../src/BaseCliAgent/runCommandEffect.js";
import { runRpcCommandEffect } from "../../src/BaseCliAgent/runRpcCommandEffect.js";

const [agentPidFile, spawnedPidFile, mode = "capture"] = process.argv.slice(2);

const commandArgs = [
  "-e",
  `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(process.env.SMITHERS_TEST_AGENT_PIDS, process.pid + ":" + child.pid);
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `,
];
const commonOptions = {
  cwd: process.cwd(),
  env: { ...process.env, SMITHERS_TEST_AGENT_PIDS: agentPidFile },
  onProcess: ({ phase, pid }) => {
    if (phase === "started" && typeof pid === "number") writeFileSync(spawnedPidFile, String(pid));
  },
};

await Effect.runPromise(
  mode === "rpc"
    ? runRpcCommandEffect(process.execPath, commandArgs, { ...commonOptions, prompt: "ping" })
    : runCommandEffect(process.execPath, commandArgs, commonOptions),
);

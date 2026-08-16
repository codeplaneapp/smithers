import { spawn } from "node:child_process";

// argv: <expected parent pid> <agent cwd> <command> [...args]. The agent cwd is
// passed explicitly rather than inherited: this watchdog is deliberately booted
// outside the agent's directory so a `bunfig.toml` there cannot preload into the
// watchdog process (see parentDeathCommand.js).
const [expectedParentPidText, childCwd, command, ...args] = process.argv.slice(2);
const expectedParentPid = Number(expectedParentPidText);

if (!Number.isInteger(expectedParentPid) || expectedParentPid <= 0 || !childCwd || !command) {
  process.exit(64);
}

function parentIsAlive() {
  if (process.ppid !== expectedParentPid) return false;
  try {
    process.kill(expectedParentPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// The engine may die between spawn() and this wrapper starting. Never launch
// an agent that already has no supervising engine.
if (!parentIsAlive()) process.exit(1);

const child = spawn(command, args, {
  cwd: childCwd,
  env: process.env,
  stdio: "inherit",
});
let settled = false;

function killContainedGroup() {
  if (settled) return;
  // This wrapper is spawned detached and is therefore the POSIX process-group
  // leader. The agent and its ordinary descendants inherit that group. Killing
  // the group also kills this watchdog, leaving no second orphan behind.
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } finally {
      process.exit(1);
    }
  }
}

const parentWatch = setInterval(() => {
  if (!parentIsAlive()) killContainedGroup();
}, 100);

child.once("error", (error) => {
  if (settled) return;
  settled = true;
  clearInterval(parentWatch);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(127);
});

child.once("exit", (code, signal) => {
  if (settled) return;
  settled = true;
  clearInterval(parentWatch);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

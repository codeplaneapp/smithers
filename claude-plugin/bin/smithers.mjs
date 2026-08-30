#!/usr/bin/env node
// Plugin launcher for the Smithers CLI.
//
// Config files (`.mcp.json`, `monitors/monitors.json`) can only name a static
// command, so they name this script instead of a package-runner invocation of
// the published CLI. It forwards every argument, inherits stdio byte-for-byte
// (the MCP server speaks JSON-RPC over stdin/stdout, so nothing may be written
// here), and propagates the child's exit code or signal.
//
// Dependency-free: Node built-ins plus the sibling resolver only.

import { spawn } from "node:child_process";
import { resolveSmithersCli } from "../lib/resolve-smithers-cli.mjs";

const { command, args } = resolveSmithersCli(process.cwd());
const child = spawn(command, [...args, ...process.argv.slice(2)], { stdio: "inherit" });

child.on("error", (error) => {
  console.error(`[smithers] failed to launch \`${command}\`: ${error.message}`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Windows cannot re-raise a signal; approximate the shell's 128+n with a
    // plain failure so callers still see a non-zero exit.
    if (process.platform === "win32") process.exit(1);
    else process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

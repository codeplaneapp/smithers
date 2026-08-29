import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentDeathCommand } from "../src/BaseCliAgent/parentDeathCommand.js";

const WATCHDOG_PATH = fileURLToPath(new URL("../src/BaseCliAgent/parentDeathWatchdog.js", import.meta.url));

/**
 * Build a checkout that looks like the one the review action hands an agent:
 * a `bunfig.toml` that preloads a file, and no `node_modules` to resolve it
 * from. Any Bun process booted here evaluates the preload; in CI that meant
 * Bun auto-installing the preload's import graph out of `~/.bun/install/cache`
 * and dying on `unist-util-visit-parents/do-not-use-color` (#1546). The preload
 * throws outright so the failure is deterministic instead of a cache race.
 *
 * @returns {Promise<string>}
 */
async function makeHostileCheckout() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "smithers-bunfig-")));
  await writeFile(join(dir, "bunfig.toml"), 'preload = ["./preload.js"]\n', "utf8");
  await writeFile(join(dir, "preload.js"), 'throw new Error("bunfig preload evaluated");\n', "utf8");
  return dir;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number | null; stdout: string; stderr: string }>}
 */
function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("parentDeathCommand", () => {
  test.skipIf(process.platform === "win32")("boots the watchdog outside the agent's cwd", () => {
    const invocation = parentDeathCommand("codex", ["exec"], true, "/some/agent/cwd");

    expect(invocation.contained).toBe(true);
    expect(invocation.command).toBe(process.execPath);
    // The watchdog runs beside its own source, which carries no bunfig.toml.
    expect(invocation.cwd).toBe(dirname(WATCHDOG_PATH));
    // …and the agent's cwd travels in argv instead of being inherited.
    expect(invocation.args.slice(0, 2)).toEqual([WATCHDOG_PATH, String(process.pid)]);
    expect(invocation.args[2]).toBe("/some/agent/cwd");
    expect(invocation.args.slice(3)).toEqual(["codex", "exec"]);
  });

  test("resolves a relative agent cwd against the engine, not the watchdog", () => {
    const invocation = parentDeathCommand("codex", [], true, ".");

    if (invocation.contained) expect(invocation.args[2]).toBe(process.cwd());
    else expect(invocation.cwd).toBe(".");
  });

  test("leaves uncontained invocations untouched", () => {
    const invocation = parentDeathCommand("codex", ["exec"], false, "/some/agent/cwd");

    expect(invocation).toEqual({ command: "codex", args: ["exec"], contained: false, cwd: "/some/agent/cwd" });
  });
});

describe("parentDeathWatchdog", () => {
  test.skipIf(process.platform === "win32")(
    "survives a bunfig preload in the agent's cwd and still runs the agent there (#1546)",
    async () => {
      const checkout = await makeHostileCheckout();
      try {
        // Baseline: this is the bug. Booting the watchdog *in* the checkout —
        // what smithers did before #1546 — dies before the agent is spawned.
        // Only Bun reads bunfig.toml, so the baseline is asserted only there.
        if (typeof Bun !== "undefined") {
          const inCheckout = await run(
            process.execPath,
            [WATCHDOG_PATH, String(process.pid), checkout, "pwd"],
            checkout,
          );
          expect(inCheckout.code).not.toBe(0);
          expect(inCheckout.stderr).toContain("bunfig preload evaluated");
        }

        // The fix: the same invocation, routed through parentDeathCommand.
        const invocation = parentDeathCommand("pwd", [], true, checkout);
        const fixed = await run(invocation.command, invocation.args, /** @type {string} */ (invocation.cwd));

        expect(fixed.stderr).not.toContain("bunfig preload evaluated");
        expect(fixed.code).toBe(0);
        // The agent itself still runs in the checkout it was asked for.
        expect(fixed.stdout.trim()).toBe(checkout);
      } finally {
        await rm(checkout, { recursive: true, force: true });
      }
    },
  );
});

import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunServices";
import { workspaceAdd } from "../src/jj.js";
import { resolveJjBinary } from "../src/resolveJjBinary.js";
import * as barrel from "../src/index.js";

const JJ_ENV = "SMITHERS_JJ_PATH";

/**
 * Install a throwaway `jj` that runs `script` for every invocation, point
 * SMITHERS_JJ_PATH at it, run `fn`, then restore the environment.
 * @param {string} script POSIX/batch body
 * @param {() => Promise<void>} fn
 */
async function withFakeJj(script, fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jj-eacces-"));
  const binPath = path.join(tmp, process.platform === "win32" ? "jj.cmd" : "jj");
  if (process.platform === "win32") {
    const bashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
    const scriptPath = path.join(tmp, "jj.sh");
    await fs.writeFile(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\n${script}`, { mode: 0o755 });
    await fs.writeFile(binPath, `@echo off\r\n"${bashPath}" "%~dp0jj.sh" %*\r\n`, { mode: 0o755 });
  } else {
    await fs.writeFile(binPath, `#!/usr/bin/env bash\nset -euo pipefail\n${script}`, { mode: 0o755 });
  }
  const prevJj = process.env[JJ_ENV];
  process.env[JJ_ENV] = binPath;
  try {
    await fn();
  } finally {
    if (prevJj === undefined) delete process.env[JJ_ENV];
    else process.env[JJ_ENV] = prevJj;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** @param {import("effect").Effect.Effect<any, any, any>} effect */
function runVcs(effect) {
  return Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)));
}

// Every jj invocation reports a permission-denied spawn error, so all
// workspace-add attempts fail with an EACCES-shaped message.
const EACCES_SCRIPT = `echo "EACCES: permission denied" 1>&2; exit 126`;

describe("workspaceAdd permission-denied hint", () => {
  test("surfaces chmod + quarantine guidance on darwin", async () => {
    const prevPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      await withFakeJj(EACCES_SCRIPT, async () => {
        const res = await runVcs(workspaceAdd("ws", "/tmp/eacces-wc"));
        expect(res.success).toBe(false);
        const err = res.error ?? "";
        expect(err).toContain("cannot execute the jj binary");
        expect(err).toContain("chmod +x");
        expect(err).toContain("xattr -d com.apple.quarantine");
      });
    } finally {
      Object.defineProperty(process, "platform", { value: prevPlatform, configurable: true });
    }
  });

  test("omits the macOS quarantine tip on non-darwin platforms", async () => {
    const prevPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await withFakeJj(EACCES_SCRIPT, async () => {
        const res = await runVcs(workspaceAdd("ws", "/tmp/eacces-wc-linux"));
        expect(res.success).toBe(false);
        const err = res.error ?? "";
        expect(err).toContain("chmod +x");
        expect(err).not.toContain("xattr");
        expect(err).toContain("point SMITHERS_JJ_PATH at a working jj");
      });
    } finally {
      Object.defineProperty(process, "platform", { value: prevPlatform, configurable: true });
    }
  });
});

describe("resolveJjBinary PATH fallback", () => {
  test("falls back to bare 'jj' when no bundled package targets the host", () => {
    const prevJj = process.env[JJ_ENV];
    const prevArch = process.arch;
    delete process.env[JJ_ENV];
    // An unsupported arch has no bundled package, so resolution walks past the
    // bundled branch to the bare-"jj" PATH fallback.
    Object.defineProperty(process, "arch", { value: "mips", configurable: true });
    try {
      expect(resolveJjBinary()).toEqual({ path: "jj", source: "path" });
    } finally {
      Object.defineProperty(process, "arch", { value: prevArch, configurable: true });
      if (prevJj === undefined) delete process.env[JJ_ENV];
      else process.env[JJ_ENV] = prevJj;
    }
  });
});

describe("index barrel re-exports", () => {
  test("re-exports the vcs public surface", () => {
    expect(typeof barrel.findVcsRoot).toBe("function");
    expect(typeof barrel.runJj).toBe("function");
    expect(typeof barrel.workspaceAdd).toBe("function");
    expect(typeof barrel.resolveJjBinary).toBe("function");
    expect(typeof barrel.resolveGitBinary).toBe("function");
    expect(typeof barrel.vcsToolingStatus).toBe("function");
  });
});

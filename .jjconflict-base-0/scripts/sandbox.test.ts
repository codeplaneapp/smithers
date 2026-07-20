import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Real-subprocess tests for scripts/sandbox.ts: the script must invoke gcloud
// with an argument array and no shell, and must validate the .sandbox-vm state
// fields before use. A fake `gcloud` executable on PATH captures the exact
// argv of every invocation (NUL-separated, one line per call).
//
// Run with: bun test scripts/sandbox.test.ts

const SANDBOX_SCRIPT = join(import.meta.dir, "sandbox.ts");
const STATE_FILE = ".sandbox-vm";
const ARGV_LOG_ENV = "SANDBOX_TEST_ARGV_LOG";

let fakeBinDir: string;

beforeAll(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), "sandbox-fake-bin-"));
  const fakeGcloud = join(fakeBinDir, "gcloud");
  writeFileSync(
    fakeGcloud,
    `#!/bin/sh\n{ printf '%s\\0' "$@"; printf '\\n'; } >> "\$${ARGV_LOG_ENV}"\nexit "\${SANDBOX_TEST_GCLOUD_EXIT:-0}"\n`,
  );
  chmodSync(fakeGcloud, 0o755);
});

function makeWorkDir(): { dir: string; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-test-"));
  return { dir, logPath: join(dir, "argv.log") };
}

function runSandbox(
  args: string[],
  dir: string,
  logPath: string,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [SANDBOX_SCRIPT, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      [ARGV_LOG_ENV]: logPath,
      ...extraEnv,
    },
    encoding: "utf8" as const,
  });
}

function readInvocations(logPath: string): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\0").slice(0, -1));
}

describe("sandbox up", () => {
  test("invokes gcloud create and ssh with exact argument arrays", () => {
    const { dir, logPath } = makeWorkDir();
    const result = runSandbox(["up"], dir, logPath);
    expect(result.status).toBe(0);

    const invocations = readInvocations(logPath);
    expect(invocations).toHaveLength(2);

    const [create, ssh] = invocations;
    expect(create.slice(0, 3)).toEqual(["compute", "instances", "create"]);
    const name = create[3];
    expect(name).toMatch(/^sandbox-\d{14}$/);
    expect(create.slice(4)).toEqual([
      "--machine-type=e2-small",
      "--image-family=debian-12",
      "--image-project=debian-cloud",
      "--zone=us-central1-a",
    ]);
    expect(ssh).toEqual(["compute", "ssh", name, "--zone=us-central1-a", "--ssh-flag=-A"]);

    const state = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
    expect(state).toEqual({ name, zone: "us-central1-a" });
  });

  test("propagates a gcloud create failure and writes no state file", () => {
    const { dir, logPath } = makeWorkDir();
    const result = runSandbox(["up"], dir, logPath, { SANDBOX_TEST_GCLOUD_EXIT: "7" });
    expect(result.status).toBe(7);
    // create failed, so no ssh attempt and no state file
    expect(readInvocations(logPath)).toHaveLength(1);
    expect(existsSync(join(dir, STATE_FILE))).toBe(false);
  });
});

describe("sandbox down", () => {
  test("deletes the VM from a valid state file with an exact argument array", () => {
    const { dir, logPath } = makeWorkDir();
    writeFileSync(
      join(dir, STATE_FILE),
      JSON.stringify({ name: "sandbox-20260712010101", zone: "us-central1-a" }),
    );
    const result = runSandbox(["down"], dir, logPath);
    expect(result.status).toBe(0);

    expect(readInvocations(logPath)).toEqual([
      ["compute", "instances", "delete", "sandbox-20260712010101", "--zone=us-central1-a", "--quiet"],
    ]);
    expect(existsSync(join(dir, STATE_FILE))).toBe(false);
  });

  test("propagates a gcloud delete failure and keeps the state file", () => {
    const { dir, logPath } = makeWorkDir();
    writeFileSync(
      join(dir, STATE_FILE),
      JSON.stringify({ name: "sandbox-20260712010101", zone: "us-central1-a" }),
    );
    const result = runSandbox(["down"], dir, logPath, { SANDBOX_TEST_GCLOUD_EXIT: "7" });
    expect(result.status).toBe(7);
    expect(readInvocations(logPath)).toHaveLength(1);
    expect(existsSync(join(dir, STATE_FILE))).toBe(true);
  });

  test("errors without invoking gcloud when no state file exists", () => {
    const { dir, logPath } = makeWorkDir();
    const result = runSandbox(["down"], dir, logPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No sandbox VM found");
    expect(readInvocations(logPath)).toEqual([]);
  });

  test("rejects a corrupt state file without invoking gcloud", () => {
    const { dir, logPath } = makeWorkDir();
    writeFileSync(join(dir, STATE_FILE), "not json{{");
    const result = runSandbox(["down"], dir, logPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Corrupt ${STATE_FILE}`);
    expect(readInvocations(logPath)).toEqual([]);
  });

  test("rejects non-string state fields without invoking gcloud", () => {
    for (const state of [
      { name: 42, zone: "us-central1-a" },
      { name: "sandbox-a", zone: ["us-central1-a"] },
      { name: "sandbox-a" },
      null,
    ]) {
      const { dir, logPath } = makeWorkDir();
      writeFileSync(join(dir, STATE_FILE), JSON.stringify(state));
      const result = runSandbox(["down"], dir, logPath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Invalid ${STATE_FILE}`);
      expect(readInvocations(logPath)).toEqual([]);
    }
  });

  // With the old execSync string interpolation, each of these payloads would
  // have executed `touch pwned` (or split/altered the delete arguments) via
  // /bin/sh. Now they must be rejected before gcloud is ever invoked, and the
  // payload must never run.
  const SHELL_PAYLOADS: Array<[label: string, payload: string]> = [
    ["space", "sandbox-a b"],
    ["double quotes", 'sandbox-a";touch pwned;"'],
    ["single quotes", "sandbox-a';touch pwned;'"],
    ["semicolon", "sandbox-a;touch pwned"],
    ["backticks", "sandbox-a`touch pwned`"],
    ["dollar subshell", "sandbox-a$(touch pwned)"],
    ["dollar variable", "sandbox-a-$HOME"],
  ];

  for (const [label, payload] of SHELL_PAYLOADS) {
    test(`rejects a name containing ${label} and never executes the payload`, () => {
      const { dir, logPath } = makeWorkDir();
      writeFileSync(join(dir, STATE_FILE), JSON.stringify({ name: payload, zone: "us-central1-a" }));
      const result = runSandbox(["down"], dir, logPath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Invalid ${STATE_FILE}`);
      expect(readInvocations(logPath)).toEqual([]);
      expect(existsSync(join(dir, "pwned"))).toBe(false);
      // A rejected state file is left in place for manual cleanup.
      expect(existsSync(join(dir, STATE_FILE))).toBe(true);
    });

    test(`rejects a zone containing ${label} and never executes the payload`, () => {
      const { dir, logPath } = makeWorkDir();
      writeFileSync(join(dir, STATE_FILE), JSON.stringify({ name: "sandbox-a", zone: payload }));
      const result = runSandbox(["down"], dir, logPath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Invalid ${STATE_FILE}`);
      expect(readInvocations(logPath)).toEqual([]);
      expect(existsSync(join(dir, "pwned"))).toBe(false);
    });
  }
});

describe("sandbox usage", () => {
  test("unknown command prints usage and exits non-zero", () => {
    const { dir, logPath } = makeWorkDir();
    const result = runSandbox(["sideways"], dir, logPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: pnpm sandbox:[up|down]");
    expect(readInvocations(logPath)).toEqual([]);
  });
});

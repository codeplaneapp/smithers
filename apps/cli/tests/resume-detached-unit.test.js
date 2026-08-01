import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeRunDetached, resumeRunDetachedLogFile } from "../src/resume-detached.js";

/**
 * Write a real executable that records its cwd and argv next to itself, then
 * emits one line to each inherited output stream. Using an executable keeps
 * this test on Node's real spawn path and avoids Bun's process-global
 * mock.module cache.
 *
 * @param {string} dir
 */
function createSpawnStub(dir) {
  const executable = join(dir, "bun-stub");
  const recordFile = `${executable}.record`;
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      "{",
      "  printf 'cwd=%s\\n' \"$PWD\"",
      '  for arg in "$@"; do printf \'arg=%s\\n\' "$arg"; done',
      '} > "$0.record"',
      "printf 'stub-stdout\\n'",
      "printf 'stub-stderr\\n' >&2",
      "",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  return { executable, recordFile };
}

/** @param {() => boolean} predicate */
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for detached spawn stub");
}

describe("resumeRunDetached", () => {
  test("spawns `smithers up --resume` detached in the workflow cwd and logs both output streams", async () => {
    const wfDir = mkdtempSync(join(tmpdir(), "smithers-resume-detached-"));
    try {
      const workflowPath = join(wfDir, "workflow.tsx");
      const { executable, recordFile } = createSpawnStub(wfDir);
      const pid = resumeRunDetached(workflowPath, "run-abc", undefined, { executable });
      expect(pid).toBeGreaterThan(0);

      const logFile = resumeRunDetachedLogFile(workflowPath, "run-abc");
      await waitFor(() => {
        if (!existsSync(recordFile) || !existsSync(logFile)) return false;
        const log = readFileSync(logFile, "utf8");
        return log.includes("stub-stdout") && log.includes("stub-stderr");
      });
      const spawnRecord = readFileSync(recordFile, "utf8").trimEnd().split("\n");
      const args = spawnRecord.filter((line) => line.startsWith("arg=")).map((line) => line.slice(4));
      expect(spawnRecord).toContain(`cwd=${realpathSync(wfDir)}`);
      expect(args).toContain("up");
      expect(args).toContain(workflowPath);
      expect(args).toContain("--resume");
      expect(args).toContain("--run-id");
      expect(args).toContain("run-abc");
      expect(args).toContain("-d");
      expect(args).toContain("--force");
      expect(args).not.toContain("--resume-claim-owner");
      expect(logFile.endsWith(join(".smithers", "logs", "run-abc.log"))).toBe(true);
    } finally {
      rmSync(wfDir, { recursive: true, force: true });
    }
  });

  test("still spawns when the detached log location is unusable", async () => {
    const wfDir = mkdtempSync(join(tmpdir(), "smithers-resume-detached-"));
    try {
      mkdirSync(join(wfDir, ".smithers"), { recursive: true });
      writeFileSync(join(wfDir, ".smithers", "logs"), "not a directory");
      const { executable, recordFile } = createSpawnStub(wfDir);

      const pid = resumeRunDetached(join(wfDir, "workflow.tsx"), "run-nolog", undefined, { executable });
      expect(pid).toBeGreaterThan(0);
      await waitFor(() => existsSync(recordFile) && readFileSync(recordFile, "utf8").includes("arg=run-nolog"));
    } finally {
      rmSync(wfDir, { recursive: true, force: true });
    }
  });

  test("appends the full claim (owner + heartbeat + restore owner/heartbeat)", async () => {
    const wfDir = mkdtempSync(join(tmpdir(), "smithers-resume-detached-"));
    try {
      const { executable, recordFile } = createSpawnStub(wfDir);
      const pid = resumeRunDetached(
        join(wfDir, "workflow.tsx"),
        "run-xyz",
        {
          claimOwnerId: "owner-1",
          claimHeartbeatAtMs: 111,
          restoreRuntimeOwnerId: "restore-owner",
          restoreHeartbeatAtMs: 222,
        },
        { executable },
      );
      expect(pid).toBeGreaterThan(0);
      await waitFor(() => existsSync(recordFile) && readFileSync(recordFile, "utf8").includes("arg=222"));
      const args = readFileSync(recordFile, "utf8")
        .trimEnd()
        .split("\n")
        .filter((line) => line.startsWith("arg="))
        .map((line) => line.slice(4));
      expect(args).toEqual(
        expect.arrayContaining([
          "--resume-claim-owner",
          "owner-1",
          "--resume-claim-heartbeat",
          "111",
          "--resume-restore-owner",
          "restore-owner",
          "--resume-restore-heartbeat",
          "222",
        ]),
      );
    } finally {
      rmSync(wfDir, { recursive: true, force: true });
    }
  });

  test("omits the restore-owner/heartbeat flags when they are null or undefined", async () => {
    const wfDir = mkdtempSync(join(tmpdir(), "smithers-resume-detached-"));
    try {
      const { executable, recordFile } = createSpawnStub(wfDir);
      resumeRunDetached(
        join(wfDir, "workflow.tsx"),
        "run-x",
        {
          claimOwnerId: "owner-2",
          claimHeartbeatAtMs: 5,
          restoreRuntimeOwnerId: null,
          restoreHeartbeatAtMs: undefined,
        },
        { executable },
      );
      await waitFor(() => existsSync(recordFile) && readFileSync(recordFile, "utf8").includes("arg=owner-2"));
      const args = readFileSync(recordFile, "utf8");
      expect(args).toContain("arg=--resume-claim-owner\n");
      expect(args).not.toContain("arg=--resume-restore-owner\n");
      expect(args).not.toContain("arg=--resume-restore-heartbeat\n");
    } finally {
      rmSync(wfDir, { recursive: true, force: true });
    }
  });

  test("fails instead of claiming a detached launch when the executable is missing", () => {
    const wfDir = mkdtempSync(join(tmpdir(), "smithers-resume-detached-"));
    try {
      expect(() =>
        resumeRunDetached(join(wfDir, "workflow.tsx"), "run-nopid", undefined, {
          executable: join(wfDir, "missing-bun"),
        }),
      ).toThrow("Failed to spawn detached resume for run run-nopid");
    } finally {
      rmSync(wfDir, { recursive: true, force: true });
    }
  });
});

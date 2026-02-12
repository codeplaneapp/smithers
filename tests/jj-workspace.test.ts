import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as vcs from "../src/vcs/jj";

async function withFakeJj(script: string, fn: () => Promise<void>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jj-bin-"));
  const binPath = path.join(tmp, process.platform === "win32" ? "jj.cmd" : "jj");
  const content = process.platform === "win32"
    ? `@echo off\r\n${script.replaceAll("\n", "\r\n")}`
    : `#!/usr/bin/env bash\nset -euo pipefail\n${script}`;
  await fs.writeFile(binPath, content, { mode: 0o755 });
  const prevPath = process.env.PATH || "";
  process.env.PATH = `${tmp}${path.delimiter}${prevPath}`;
  try {
    await fn();
  } finally {
    process.env.PATH = prevPath;
    try { await fs.rm(tmp, { recursive: true, force: true }); } catch {}
  }
}

describe("runJj", () => {
  test("returns non-zero and stderr on failure", async () => {
    await withFakeJj(
      `echo "bad flag" 1>&2; exit 2`,
      async () => {
        const res = await vcs.runJj(["--does-not-exist"]);
        expect(res.code).not.toBe(0);
        expect(res.stderr).toContain("bad flag");
      },
    );
  });
});

describe("isJjRepo", () => {
  test("true when log command succeeds", async () => {
    const script = `
case "$1 $2 $3 $4 $5" in
  "log -r @ -n 1") echo ok; exit 0;;
  *) echo unknown 1>&2; exit 1;;
esac
`;
    await withFakeJj(script, async () => {
      const ok = await vcs.isJjRepo();
      expect(ok).toBe(true);
    });
  });
});

describe("workspaceAdd", () => {
  test("uses primary syntax: path then --name", async () => {
    const script = `
if [[ "$1" = "workspace" && "$2" = "add" && "$4" = "--name" && "$6" = "-r" ]]; then
  # "$3" is path, "$5" is name, "$7" is rev
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.workspaceAdd("myws", "/tmp/wc", { atRev: "abc" });
      expect(res.success).toBe(true);
    });
  });

  test("falls back to legacy name path form", async () => {
    const script = `
if [[ "$1" = "workspace" && "$2" = "add" && "$3" != "--wc-path" && "$3" != "-r" && "$6" = "-r" ]]; then
  # legacy: name path -r rev  (positions 3,4,6)
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.workspaceAdd("legacy", "/tmp/legacy", { atRev: "zzz" });
      expect(res.success).toBe(true);
    });
  });
});

describe("workspaceList", () => {
  test("uses -T for structured names output", async () => {
    const script = `
if [[ "$1" = "workspace" && "$2" = "list" && "$3" = "-T" ]]; then
  # print only names, one per line
  echo "default"
  echo "other"
  echo "solo"
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const rows = await vcs.workspaceList();
      expect(rows).toEqual([
        { name: "default", path: null, selected: false },
        { name: "other", path: null, selected: false },
        { name: "solo", path: null, selected: false },
      ]);
    });
  });
});

describe("workspaceClose", () => {
  test("uses forget subcommand", async () => {
    const script = `
if [[ "$1" = "workspace" && "$2" = "forget" && "$3" = "myws" ]]; then
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.workspaceClose("myws");
      expect(res.success).toBe(true);
    });
  });
});

describe("getJjPointer", () => {
  test("returns trimmed change_id string", async () => {
    const script = `
if [[ "$1" = "log" && "$2" = "-r" && "$3" = "@" && "$4" = "--no-graph" && "$5" = "--template" && "$6" = "change_id" ]]; then
  echo "abc123"
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const ptr = await vcs.getJjPointer();
      expect(ptr).toBe("abc123");
    });
  });
});

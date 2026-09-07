import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselinePath, canonical, fixturePath, LIVE_TOKEN_ENV, main, usage, type Fetch } from "./run.ts";
import { parseLog, scoreLog } from "./score.ts";

const runScript = join(import.meta.dirname, "run.ts");

interface Captured {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

async function capture(
  argv: string[],
  options: { env?: Record<string, string | undefined>; fetch?: Fetch } = {},
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    env: options.env ?? {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    fetch: options.fetch ?? (() => Promise.reject(new Error("no network in this test"))),
  });
  return { stdout, stderr, code };
}

function fixtureLines(): string[] {
  return readFileSync(fixturePath, "utf8").trimEnd().split("\n");
}

describe("the fixture and the baseline", () => {
  test("the fixture covers a top-1 hit, a lower hit, a miss, and a pending row, in at least 12 rows", () => {
    const rows = parseLog(readFileSync(fixturePath, "utf8"));
    expect(rows.length).toBeGreaterThanOrEqual(12);
    const decided = rows.filter((row) => row.outcome !== null);
    expect(decided.some((row) => row.commands[0] === row.outcome!.command)).toBe(true);
    expect(decided.some((row) => row.commands.indexOf(row.outcome!.command) > 0)).toBe(true);
    expect(decided.some((row) => !row.commands.includes(row.outcome!.command))).toBe(true);
    expect(rows.some((row) => row.outcome === null)).toBe(true);
    expect(new Set(rows.map((row) => row.repo)).size).toBeGreaterThanOrEqual(2);
    expect(rows.some((row) => row.repo === null)).toBe(true);
    for (const row of rows) expect(row.tailDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("scoring the fixture reproduces baseline.json byte for byte", () => {
    const score = scoreLog(parseLog(readFileSync(fixturePath, "utf8")));
    expect(canonical(score)).toBe(readFileSync(baselinePath, "utf8"));
    // The numbers the fixture was built to produce.
    expect(score.rows).toBe(16);
    expect(score.withOutcome).toBe(13);
    expect(score.hits).toBe(9);
    expect(score.top1).toBe(5);
  });
});

describe("run.ts", () => {
  test("--help prints usage and exits 0", async () => {
    const result = await capture(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(usage);
    expect(result.stdout).toMatch(/--live/);
    expect(result.stdout).toMatch(new RegExp(LIVE_TOKEN_ENV));
  });

  test("no flag scores the fixture, prints the table, and matches the baseline", async () => {
    const result = await capture([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^recommend eval: 16 rows, 13 with an outcome/);
    expect(result.stdout).toMatch(/overall\s+16\s+13\s+81\.3%\s+69\.2%\s+38\.5%/);
    expect(result.stdout).toMatch(/matches the baseline/);
  });

  test("--input scores any log and consults no baseline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recommend-eval-"));
    const path = join(dir, "log.jsonl");
    // Two rows: one top-1 hit, one pending. Nothing like the baseline.
    writeFileSync(path, `${fixtureLines()[0]}\n${fixtureLines()[3]}\n`);
    const result = await capture(["--input", path]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^recommend eval: 2 rows, 1 with an outcome/);
    expect(result.stdout).toMatch(/overall\s+2\s+1\s+50\.0%\s+100\.0%\s+100\.0%/);
    expect(result.stdout).not.toMatch(/baseline/);
  });

  test("--json prints the canonical score", async () => {
    const result = await capture(["--input", fixturePath, "--json"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(readFileSync(baselinePath, "utf8"));
  });

  test("a malformed log exits 2 and names the line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recommend-eval-"));
    const path = join(dir, "log.jsonl");
    writeFileSync(path, `${fixtureLines()[0]}\n{"id":"rec_x","repo":null,"commands":"flow.list","outcome":null}\n`);
    const result = await capture(["--input", path]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/line 2: rec_x: commands must be an array of strings/);
    expect(result.stdout).toBe("");
  });

  test("a missing file, a bare --input, and an unknown flag exit 2", async () => {
    expect((await capture(["--input", "/nonexistent/log.jsonl"])).code).toBe(2);
    expect((await capture(["--input"])).code).toBe(2);
    expect((await capture(["--nope"])).code).toBe(2);
    expect((await capture(["--live", "--input", fixturePath])).code).toBe(2);
  });

  test("--live refuses to pull without the admin token and never prints it", async () => {
    let calls = 0;
    const result = await capture(["--live"], {
      env: {},
      fetch: () => {
        calls += 1;
        return Promise.reject(new Error("unreachable"));
      },
    });
    expect(result.code).toBe(3);
    expect(calls).toBe(0);
    expect(result.stderr).toMatch(new RegExp(`${LIVE_TOKEN_ENV} is unset`));
  });

  test("--live sends the bearer to the admin route of the configured origin and scores the rows", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const rows = fixtureLines().slice(0, 4).map((line) => JSON.parse(line));
    const result = await capture(["--live"], {
      env: { SMITHERS_ORIGIN: "https://canary.example/", [LIVE_TOKEN_ENV]: "secret-token" },
      fetch: (url, init) => {
        seen.push({ url, authorization: init.headers.authorization ?? null });
        return Promise.resolve(new Response(JSON.stringify({ rows }), { status: 200 }));
      },
    });
    expect(result.code).toBe(0);
    expect(seen).toEqual([
      { url: "https://canary.example/api/admin/recommend/log?limit=2000", authorization: "Bearer secret-token" },
    ]);
    expect(result.stdout).toMatch(/^recommend eval: 4 rows, 3 with an outcome/);
    expect(result.stdout).not.toMatch(/secret-token/);
    expect(result.stderr).toBe("");
  });

  test("--live reports a refused pull with the status and exits 3", async () => {
    const result = await capture(["--live"], {
      env: { [LIVE_TOKEN_ENV]: "secret-token" },
      fetch: () => Promise.resolve(new Response("no", { status: 401 })),
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/answered 401/);
    expect(result.stderr).not.toMatch(/secret-token/);
  });

  test("the launch line runs under bun and exits 0 on the committed baseline", () => {
    const result = spawnSync("bun", [runScript], { encoding: "utf8", timeout: 60_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/matches the baseline/);
    const help = spawnSync("bun", [runScript, "--help"], { encoding: "utf8", timeout: 60_000 });
    expect(help.status).toBe(0);
    expect(help.stdout).toBe(usage);
  });
});

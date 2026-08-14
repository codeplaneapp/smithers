// Tests for CLI input/flag validation that doesn't require a workflow.
//
// Each scenario uses runSmithers (a real Bun subprocess) so the tests
// observe what an end user would observe — the same argv parsing path,
// the same error rendering, and the same exit codes. We only stress
// behaviors that require neither a runnable workflow nor a working
// node_modules tree, so these stay green even in worktrees that lack
// full e2e dependencies.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

describe("conflicting / invalid flag combinations", () => {
  test("--supervise without --serve on `up` exits non-zero with a clear message", () => {
    const repo = createTempRepo();
    // Workflow path doesn't have to be valid: the --supervise/--serve
    // gate is checked before the workflow is loaded.
    const result = runSmithers(["up", "fake-workflow.tsx", "--supervise"], {
      cwd: repo.dir,
      format: null,
    });
    expect(result.exitCode).not.toBe(0);
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).toContain("--supervise");
    expect(all.toLowerCase()).toContain("--serve");
  });

  test("--resume-claim-owner without --heartbeat fails before workflow load", () => {
    const repo = createTempRepo();
    const result = runSmithers(["up", "fake-workflow.tsx", "--resume-claim-owner", "owner-1"], {
      cwd: repo.dir,
      format: null,
    });
    expect(result.exitCode).not.toBe(0);
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).toContain("--resume-claim-owner");
    expect(all).toContain("--resume-claim-heartbeat");
  });

  test("up --dry-run redirects to `smithers graph` instead of a bare Unknown flag", () => {
    const repo = createTempRepo();
    // `up` has no --dry-run flag; an agent that reaches for it (matching the
    // CLI convention and sibling verbs `update`/`supervise`) should be
    // pointed at `smithers graph`, the actual dry-run path.
    const result = runSmithers(["up", "fake-workflow.tsx", "--dry-run"], {
      cwd: repo.dir,
      format: null,
    });
    expect(result.exitCode).not.toBe(0);
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).toContain("smithers graph");
    expect(all).not.toContain("Unknown flag: --dry-run");
  });

  test("gateway --port rejects values above 65535 during flag validation", () => {
    const repo = createTempRepo();
    const result = runSmithers(["gateway", "--port", "99999"], {
      cwd: repo.dir,
      format: null,
    });
    const all = `${result.stdout}\n${result.stderr}`;
    expect(result.exitCode).not.toBe(0);
    expect(all).toContain("65535");
    expect(all).not.toContain("ERR_SOCKET_BAD_PORT");
  });

  test("up --serve --port rejects values above 65535 during flag validation", () => {
    const repo = createTempRepo();
    const result = runSmithers(["up", "fake-workflow.tsx", "--serve", "--port", "99999"], {
      cwd: repo.dir,
      format: null,
    });
    const all = `${result.stdout}\n${result.stderr}`;
    expect(result.exitCode).not.toBe(0);
    expect(all).toContain("65535");
    expect(all).not.toContain("ERR_SOCKET_BAD_PORT");
  });

  test("unknown subcommand exits non-zero", () => {
    const repo = createTempRepo();
    const result = runSmithers(["totally-not-a-real-subcommand"], {
      cwd: repo.dir,
      format: null,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown command");
  });

  test("--input with malformed JSON does not produce a raw V8 stack trace", () => {
    const repo = createTempRepo();
    const result = runSmithers(["up", "fake-workflow.tsx", "--input", "{not-json"], { cwd: repo.dir, format: null });
    // Whether we surface INVALID_JSON or a workflow-load error first,
    // the user must NOT see a Node-internal stack frame.
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).not.toContain("processTicksAndRejections");
  }, 30_000);
});

describe("pre-serve fast-path errors honor the CLI error contract, not a raw rejection (H19)", () => {
  // The raw-JSON timeline fast path runs before `cli.serve` and outside its
  // try/catch. Before main() got a `.catch` + unhandledRejection handler, a
  // throw here rejected unhandled and Bun printed a raw V8 stack, bypassing
  // the clean-message + JSON-envelope contract.
  test("`timeline <id> --format json` with no store emits a clean JSON error, not a V8 stack", () => {
    const repo = createTempRepo();
    const result = runSmithers(["timeline", "missing-run"], { cwd: repo.dir, format: "json" });
    expect(result.exitCode).not.toBe(0);
    // A machine reader still gets a single parseable document on stdout ...
    expect(result.json?.code).toBe("CLI_DB_NOT_FOUND");
    // ... and never the raw V8 stack an unhandled rejection would dump.
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).not.toContain("SmithersError:");
    expect(all).not.toContain("assertReadStoreExists");
    expect(all).not.toContain("processTicksAndRejections");
  });

  test("`timeline <id> --json` with no store emits a clean JSON error, not a V8 stack", () => {
    const repo = createTempRepo();
    const result = runSmithers(["timeline", "missing-run", "--json"], { cwd: repo.dir, format: null });
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.code).toBe("CLI_DB_NOT_FOUND");
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).not.toContain("SmithersError:");
    expect(all).not.toContain("assertReadStoreExists");
  });
});

describe("documented negated boolean flags parse", () => {
  // Regression: incur reads `--no-<x>` as "negate the boolean option <x>".
  // Declaring the option as `noX` (kebab `no-x`) made `--help` advertise
  // `--no-x` while the parser rejected it as "Unknown flag" — the flag was
  // unreachable. The negatable options must be declared positively (`x`,
  // default true) so `--no-x` actually parses.
  const writeFlagWorkflow = (repo) => {
    // A workflow file that exists so flag parsing is the only thing under
    // test; the commands fail later at the run/attempt lookup, not at parse.
    writeTestWorkflow(repo);
  };

  test("timetravel --no-vcs --no-deps parse (not rejected as Unknown flag)", () => {
    const repo = createTempRepo();
    writeFlagWorkflow(repo);
    const result = runSmithers(
      ["timetravel", "workflow.tsx", "--run-id", "missing-run", "--node-id", "x", "--no-vcs", "--no-deps", "--force"],
      { cwd: repo.dir, format: null },
    );
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).not.toContain("Unknown flag");
  }, 30_000);

  test("retry-task --no-deps parses (not rejected as Unknown flag)", () => {
    const repo = createTempRepo();
    writeFlagWorkflow(repo);
    const result = runSmithers(
      ["retry-task", "workflow.tsx", "--run-id", "missing-run", "--node-id", "x", "--no-deps"],
      { cwd: repo.dir, format: null },
    );
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).not.toContain("Unknown flag");
  }, 30_000);

  test("retry-task -d/--detach parses (not rejected as Unknown flag)", () => {
    const repo = createTempRepo();
    writeFlagWorkflow(repo);
    const result = runSmithers(["retry-task", "workflow.tsx", "--run-id", "missing-run", "--node-id", "x", "-d"], {
      cwd: repo.dir,
      format: null,
    });
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).not.toContain("Unknown flag");
  }, 30_000);

  test("retry-task --accept-workflow-change parses (not rejected as Unknown flag)", () => {
    const repo = createTempRepo();
    writeFlagWorkflow(repo);
    const result = runSmithers(
      ["retry-task", "workflow.tsx", "--run-id", "missing-run", "--node-id", "x", "--accept-workflow-change"],
      { cwd: repo.dir, format: null },
    );
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).not.toContain("Unknown flag");
  }, 30_000);

  test("ask --no-mcp parses (not rejected as Unknown flag)", () => {
    const repo = createTempRepo();
    const result = runSmithers(["ask", "--no-mcp", "--list-agents"], {
      cwd: repo.dir,
      format: null,
    });
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).not.toContain("Unknown flag");
  }, 30_000);
});

describe("NO_COLOR / TTY handling", () => {
  test("NO_COLOR=1 in env strips ANSI color codes from --help output", () => {
    const repo = createTempRepo();
    const result = runSmithers(["--help"], {
      cwd: repo.dir,
      format: null,
      env: { NO_COLOR: "1" },
    });
    expect(result.exitCode).toBe(0);
    // ESC sequences ("\u001b[") should not appear when NO_COLOR is set
    // (and stdout in spawnSync is non-TTY anyway, which compounds the
    // effect — this is the documented Unix-conventional behavior).
    expect(result.stdout).not.toContain("\u001b[");
  });

  test("non-TTY stdout still produces help output (no color required)", () => {
    const repo = createTempRepo();
    const result = runSmithers(["--help"], {
      cwd: repo.dir,
      format: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: smithers <command>");
  });

  test("very narrow COLUMNS does not crash help rendering", () => {
    const repo = createTempRepo();
    const result = runSmithers(["--help"], {
      cwd: repo.dir,
      format: null,
      env: { COLUMNS: "10" },
    });
    expect(result.exitCode).toBe(0);
    // Output should still be non-empty even when terminal is tiny.
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

describe("--input streaming via stdin", () => {
  test("`--input -` reads small JSON from stdin", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo);
    const result = runSmithers(["up", "workflow.tsx", "--input", "-"], {
      cwd: repo.dir,
      format: "json",
      stdin: JSON.stringify({ prompt: "from stdin" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: "finished" });
    const sqlite = new Database(repo.path("smithers.db"), { readonly: true });
    try {
      const row = sqlite.query('select prompt from "result" order by rowid desc limit 1').get();
      expect(row?.prompt).toBe("from stdin");
    } finally {
      sqlite.close();
    }
  });

  test("malformed stdin JSON yields INVALID_JSON", () => {
    const repo = createTempRepo();
    const result = runSmithers(["up", "fake-workflow.tsx", "--input", "-"], {
      cwd: repo.dir,
      format: null,
      stdin: "{not-json",
    });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("INVALID_JSON");
  });

  test("stdin over 1MB is rejected at the documented limit", () => {
    const repo = createTempRepo();
    const result = runSmithers(["up", "fake-workflow.tsx", "--input", "-"], {
      cwd: repo.dir,
      format: null,
      stdin: JSON.stringify({ payload: "x".repeat(1024 * 1024 + 1) }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("input");
  });
});

describe("--annotations streaming via stdin", () => {
  test("detached runs serialize `--annotations -` before spawning the child", async () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo);
    const result = runSmithers(["up", "workflow.tsx", "--detach", "--annotations", "-"], {
      cwd: repo.dir,
      format: "json",
      stdin: JSON.stringify({ channel: "ops" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.json?.runId).toBeString();
    expect(result.json?.logFile).toBeString();

    let status;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (existsSync(repo.path("smithers.db"))) {
        const sqlite = new Database(repo.path("smithers.db"), { readonly: true });
        try {
          try {
            status = sqlite.query("select status from _smithers_runs where run_id = ?").get(result.json.runId)?.status;
          } catch (err) {
            // The detached child writes this SQLite DB concurrently, so a
            // read can race the early CREATE TABLE (no such table) or hit the
            // writer's lock (database is locked). Both are transient
            // — keep polling rather than failing the test.
            const message = String(err?.message ?? err);
            const transient =
              message.includes("no such table: _smithers_runs") || message.includes("database is locked");
            if (!transient) {
              throw err;
            }
          }
        } finally {
          sqlite.close();
        }
        if (status && status !== "running") {
          break;
        }
      }
      await Bun.sleep(50);
    }
    expect(status).toBe("finished");
    expect(readFileSync(result.json.logFile, "utf8")).not.toContain("INVALID_JSON");
  }, 15_000);

  test("detached runs return monitoring guidance so the agent can offer the user a way to watch", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo);
    const result = runSmithers(["up", "workflow.tsx", "--detach"], {
      cwd: repo.dir,
      format: "json",
    });
    expect(result.exitCode).toBe(0);
    const monitoring = result.json?.monitoring;
    expect(monitoring?.text).toContain("background");
    expect(monitoring?.text).toContain(String(result.json.runId));
    expect(monitoring?.options?.map((o) => o.id)).toEqual(["monitor-ui", "cron-report", "live-ui", "html-page"]);
  });
});

describe("machine-output requests never invite interactive mode (#19)", () => {
  test("up --interactive --format json fails INTERACTIVE_REQUIRES_TTY naming the format conflict", () => {
    const repo = createTempRepo();
    const result = runSmithers(["up", "--interactive"], { cwd: repo.dir, format: "json" });
    expect(result.exitCode).toBe(4);
    expect(result.json.code).toBe("INTERACTIVE_REQUIRES_TTY");
    expect(result.json.message).toContain("--format json/jsonl");
  });

  test("up --format json with no workflow yields a pure-JSON WORKFLOW_REQUIRED envelope", () => {
    const repo = createTempRepo();
    const result = runSmithers(["up"], { cwd: repo.dir, format: "json" });
    expect(result.exitCode).toBe(4);
    // stdout must be a single parseable JSON document: no clack bytes.
    const parsed = JSON.parse(result.stdout);
    expect(parsed.code).toBe("WORKFLOW_REQUIRED");
  });
});

describe("missing required inputs surface friendly messages, not raw zod prose (#12)", () => {
  test("missing required positional: `inspect` names the argument and points at --help", () => {
    const repo = createTempRepo();
    const result = runSmithers(["inspect"], { cwd: repo.dir, format: "json" });
    expect(result.exitCode).toBe(4);
    expect(result.json.code).toBe("VALIDATION_ERROR");
    expect(result.json.message).toContain("Missing required argument <runId>");
    expect(result.json.message).toContain("smithers inspect --help");
    expect(result.json.message).not.toContain("received undefined");
    // The structured fieldErrors contract (path/missing) stays intact for
    // machine consumers (same shape init.e2e.test.js pins for invalid values).
    expect(result.json.fieldErrors).toHaveLength(1);
    expect(result.json.fieldErrors[0]).toMatchObject({ path: "runId", missing: true });
  });

  test("missing required options: `retry-task` names --run-id and --node-id in kebab-case", () => {
    const repo = createTempRepo();
    const result = runSmithers(["retry-task", "fake.tsx"], { cwd: repo.dir, format: "json" });
    expect(result.exitCode).toBe(4);
    expect(result.json.code).toBe("VALIDATION_ERROR");
    expect(result.json.message).toContain("Missing required option --run-id");
    expect(result.json.message).toContain("Missing required option --node-id");
    expect(result.json.message).toContain("smithers retry-task --help");
    expect(result.json.fieldErrors.map((fe) => fe.path).sort()).toEqual(["nodeId", "runId"]);
  });

  test("invalid (non-missing) values keep incur's original message", () => {
    const repo = createTempRepo();
    // Same contract init.e2e.test.js pins: an invalid enum value is not a
    // missing input, so the raw "Invalid input" phrasing must survive.
    const result = runSmithers(["init", "--template", "does-not-exist", "--no-install"], {
      cwd: repo.dir,
      format: "json",
    });
    expect(result.exitCode).toBe(4);
    expect(result.json.code).toBe("VALIDATION_ERROR");
    expect(result.json.message).toContain("Invalid input");
    expect(result.json.message).not.toContain("Missing required");
  });
});

describe("review honors the exit-4 usage-error contract", () => {
  // `review` bypasses incur (a raw-argv intercept in main()), so its usage
  // errors must map to exit 4 explicitly. parseReviewArgs throws on the
  // unknown flag before any Bun.which/agent check, so this exits during
  // parsing — no agent CLI or browser needed, safe on CI.
  test("review rejects unknown flags with exit 4", () => {
    const repo = createTempRepo();
    const result = runSmithers(["review", "--bogus"], { cwd: repo.dir, format: null });
    expect(result.exitCode).toBe(4);
  });
});

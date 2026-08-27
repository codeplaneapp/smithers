import { expect, test } from "bun:test";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const APPROVAL_WORKFLOW = `
/** @jsxImportSource smthrs */
import { Approval, createSmithers } from "smthrs";
import { z } from "zod";

const { Workflow, smithers, outputs } = createSmithers({
  approval: z.object({ approved: z.boolean() }),
});

export default smithers(() => (
  <Workflow name="cwd-operator-commands">
    <Approval id="gate" output={outputs.approval} request={{ title: "Continue?" }} onDeny="fail" />
  </Workflow>
));
`;

test("operator commands can target a run store outside the launching workspace", () => {
  const launcher = createTempRepo();
  const target = createTempRepo();
  pinSqliteBackend(target.dir);
  target.write("workflow.tsx", APPROVAL_WORKFLOW);

  const runId = "separate-cwd-run";
  const parked = runSmithers(["up", "workflow.tsx", "--run-id", runId, "--no-report"], {
    cwd: target.dir,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(parked.exitCode, `${parked.stdout}\n${parked.stderr}`).toBe(3);
  expect(parked.json?.status).toBe("waiting-approval");

  const ps = runSmithers(["ps", "--cwd", target.dir], {
    cwd: launcher.dir,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(ps.exitCode, `${ps.stdout}\n${ps.stderr}`).toBe(0);
  expect(ps.json?.runs?.map((run) => run.id)).toContain(runId);

  const status = runSmithers(["status", runId, "--cwd", target.dir], {
    cwd: launcher.dir,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(status.exitCode, `${status.stdout}\n${status.stderr}`).toBe(0);
  expect(JSON.stringify(status.json)).toContain(runId);

  const inspect = runSmithers(["inspect", runId, "--cwd", target.dir], {
    cwd: launcher.dir,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(inspect.exitCode, `${inspect.stdout}\n${inspect.stderr}`).toBe(0);
  expect(inspect.json?.run).toMatchObject({ id: runId, status: "waiting-approval" });

  const chat = runSmithers(["chat", runId, "--cwd", target.dir], {
    cwd: launcher.dir,
    timeoutMs: 120_000,
  });
  expect(chat.exitCode, `${chat.stdout}\n${chat.stderr}`).toBe(0);
  expect(`${chat.stdout}${chat.stderr}`).not.toContain("Run not found");

  const pause = runSmithers(["pause", runId, "--cwd", target.dir], {
    cwd: launcher.dir,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(pause.exitCode).toBe(4);
  expect(pause.json?.code).toBe("RUN_NOT_ACTIVE");

  const cancel = runSmithers(["cancel", runId, "--cwd", target.dir], {
    cwd: launcher.dir,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(cancel.exitCode, `${cancel.stdout}\n${cancel.stderr}`).toBe(2);
  expect(cancel.json).toMatchObject({ runId, status: "cancelled" });
});

test("run CTA commands expose an explicit workspace option", () => {
  const repo = createTempRepo();
  for (const command of ["ps", "status", "inspect", "chat", "hijack", "pause", "cancel", "ui", "monitor"]) {
    const help = runSmithers([command, "--help"], {
      cwd: repo.dir,
      timeoutMs: 120_000,
    });
    expect(help.exitCode, `${command}\n${help.stdout}\n${help.stderr}`).toBe(0);
    expect(`${help.stdout}${help.stderr}`, command).toContain("--cwd");
  }
});

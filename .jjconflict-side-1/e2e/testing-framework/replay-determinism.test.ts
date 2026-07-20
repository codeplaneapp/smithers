import { describe, expect, test } from "bun:test";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { realDbAdapter, integrationHarness, runScenario } from "@smithers-orchestrator/testing";
import { z } from "zod";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

const realDbRunner = () => "real-db-observed";
import { firstDivergence, makeReplayBundle, replayBundle, replayIdentity, scenario, serializeReplayBundle, step, loadReplayBundle } from "@smithers-orchestrator/testing";

describe("testing framework replay proof", () => {
  test("replays an executable bundle and reports the first control divergence", async () => {
    const ast = scenario("replay-proof", { steps: [step("a", { runnerBinding: "e2e:replay:a:v1", run: () => "a" }), step("b", { runnerBinding: "e2e:replay:b:v1", run: () => "b" })] });
    const controls = [{ type: "pin-interleaving" as const, choice: "b" }, { type: "pin-interleaving" as const, choice: "a" }];
    const original = await replayBundle(makeReplayBundle({ ast, seed: 11, controlLog: controls }), { stepRunners: { a: () => "a", b: () => "b" } });
    const bundle = loadReplayBundle(serializeReplayBundle(makeReplayBundle({ ast, seed: 11, controlLog: controls, trace: original.trace })));
    const replay = await replayBundle(bundle, { stepRunners: { a: () => "a", b: () => "b" } });
    expect(replay.status).toBe("finished");
    expect(replay.replayIdentity).toBe(bundle.replayIdentity);
    const changedControls = [{ ...controls[0], choice: "a" }, controls[1] ] as const;
    const changed = await replayBundle({ ...bundle, controlLog: changedControls, replayIdentity: replayIdentity({ ast: bundle.ast, seed: bundle.seed, controlLog: changedControls }) }, { stepRunners: { a: () => "a", b: () => "b" } });
    expect(firstDivergence(replay.trace, changed.trace)?.sequence).toBe(0);
  });

  test("replays the same binding in a fresh Bun process without the originating registry", async () => {
    const ast = scenario("fresh-process", { steps: [step("a", { runnerBinding: "e2e:fresh:a:v1" })] });
    const captured = await replayBundle(makeReplayBundle({ ast, seed: 17, controlLog: [] }), { stepRunners: { a: () => "fresh" } });
    const bundle = makeReplayBundle({ ast, seed: 17, controlLog: captured.controlLog, trace: captured.trace });
    const script = `import { replayBundle } from "@smithers-orchestrator/testing"; const b=JSON.parse(process.env.REPLAY_BUNDLE); const r=await replayBundle(b,{stepRunners:{a:()=>"fresh"}}); console.log(JSON.stringify({identity:r.replayIdentity,status:r.status,trace:r.trace,outputs:r.outputs,controlLog:r.controlLog}));`;
    const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, REPLAY_BUNDLE: JSON.stringify(bundle) }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).toBe("");
    const fresh = JSON.parse(output) as { identity: string; status: string; trace: unknown; outputs: unknown; controlLog: unknown };
    expect(fresh).toEqual({ identity: bundle.replayIdentity, status: "finished", trace: (await replayBundle(bundle, { stepRunners: { a: () => "fresh" } })).trace, outputs: { a: "fresh" }, controlLog: bundle.controlLog });
  });

  test("replays two real-db executions using a normalized durable projection", async () => {
    const run = async (suffix: string) => {
      const dbPath = join(tmpdir(), `smithers-testing-replay-${suffix}-${Date.now()}.db`);
      const { db } = createSmithers({ input: z.object({}), result: z.object({ value: z.number() }) }, { dbPath });
      ensureSmithersTables(db);
      const client = (db as { $client?: { close: () => void } }).$client!;
      const production = new SmithersDb(db);
      const resource = Object.assign(production, {
        path: dbPath,
        productionIdentity: "SmithersDb" as const,
        operations: { observed: () => "real-db-observed" },
        close: () => client.close(),
      });
      try {
        const result = await runScenario(scenario("real-db-replay", { steps: [step("observed", { runnerBinding: "e2e:real-db:observed:v1", run: realDbRunner })] }), {
          harness: integrationHarness({ adapter: realDbAdapter({ open: async () => resource }) }),
        });
        expect(result.status).toBe("finished");
        return JSON.stringify({ status: result.status, outputs: result.outputs, ambiguity: result.ambiguity, trace: result.trace });
      } finally {
        rmSync(dbPath, { force: true }); rmSync(`${dbPath}-wal`, { force: true }); rmSync(`${dbPath}-shm`, { force: true });
      }
    };
    expect(await run("a")).toBe(await run("b"));
  });
});

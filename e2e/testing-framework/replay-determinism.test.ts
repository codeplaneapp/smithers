import { describe, expect, test } from "bun:test";
import { firstDivergence, makeReplayBundle, replayBundle, scenario, serializeReplayBundle, step, loadReplayBundle } from "@smithers-orchestrator/testing";

describe("testing framework replay proof", () => {
  test("replays an executable bundle and reports the first control divergence", async () => {
    const ast = scenario("replay-proof", { steps: [step("a", { run: () => "a" }), step("b", { run: () => "b" })] });
    const controls = [{ type: "pin-interleaving" as const, choice: "b" }, { type: "pin-interleaving" as const, choice: "a" }];
    const original = await replayBundle(makeReplayBundle({ ast, seed: 11, controlLog: controls }));
    const bundle = loadReplayBundle(serializeReplayBundle(makeReplayBundle({ ast, seed: 11, controlLog: controls, trace: original.trace })));
    const replay = await replayBundle(bundle);
    expect(replay.status).toBe("finished");
    expect(replay.replayIdentity).toBe(bundle.replayIdentity);
    const changed = await replayBundle({ ...bundle, controlLog: [{ ...controls[0], choice: "a" }, controls[1] ] });
    expect(firstDivergence(replay.trace, changed.trace)?.sequence).toBeGreaterThanOrEqual(0);
  });
});

import { describe, expect, test } from "bun:test";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";
import { settleSimulation } from "../src/vault/settleSimulation";
import { computeGraphModel, nodeRadius, type VaultGraphEdge, type VaultGraphNode } from "../src/vault/graphModel";
import type { VaultLink, VaultNoteMeta } from "../src/vault/types";

const SETTLE_BUDGET_MS = 8;
type SettleTarget = Parameters<typeof settleSimulation>[0];

/** A scheduler that holds batches until the test drains it. */
function heldScheduler() {
  const queue: Array<() => void> = [];
  return {
    queue,
    schedule(run: () => void) {
      queue.push(run);
      return () => {
        const at = queue.indexOf(run);
        if (at >= 0) queue.splice(at, 1);
      };
    },
    /** Runs queued batches (and the ones they queue) to exhaustion. */
    flush() {
      let batches = 0;
      while (queue.length > 0) {
        queue.shift()!();
        batches += 1;
      }
      return batches;
    },
  };
}

/** A simulation whose every tick costs `costMs` on the fake clock. */
function fakeSim(costMs: number) {
  const clock = { ms: 0 };
  const state = { ticks: 0, stops: 0 };
  const sim: SettleTarget = {
    tick(iterations = 1) {
      state.ticks += iterations;
      clock.ms += costMs * iterations;
    },
    stop() {
      state.stops += 1;
    },
  };
  return { sim, state, now: () => clock.ms, clock };
}

describe("settleSimulation", () => {
  test("keeps each batch inside the time budget instead of ticking in one block", () => {
    const { sim, state, now, clock } = fakeSim(1);
    const scheduler = heldScheduler();
    const batches: Array<{ ticks: number; elapsed: number }> = [];
    let batchStart = 0;
    let batchTicks = 0;
    const closeBatch = () => {
      batches.push({ ticks: batchTicks, elapsed: clock.ms - batchStart });
      batchStart = clock.ms;
      batchTicks = 0;
    };
    const counting: SettleTarget = {
      tick(iterations = 1) {
        batchTicks += iterations;
        sim.tick(iterations);
      },
      stop: () => sim.stop(),
    };
    let settled = 0;

    settleSimulation(counting, {
      ticks: 180,
      now,
      schedule: (run) => {
        closeBatch();
        return scheduler.schedule(run);
      },
      onSettled: () => {
        closeBatch();
        settled += 1;
      },
    });

    // The call itself must not settle the whole layout: it runs one budgeted
    // batch and yields. Before the fix all 180 ticks ran in this continuation.
    expect(state.ticks).toBeLessThan(180);
    expect(state.ticks).toBe(SETTLE_BUDGET_MS);
    expect(scheduler.queue).toHaveLength(1);
    expect(settled).toBe(0);

    scheduler.flush();
    expect(state.ticks).toBe(180);
    expect(state.stops).toBe(1);
    expect(settled).toBe(1);
    // No batch may overrun the budget, and every one but the last is full.
    expect(Math.max(...batches.map((batch) => batch.elapsed))).toBeLessThanOrEqual(SETTLE_BUDGET_MS);
    expect(Math.max(...batches.map((batch) => batch.ticks))).toBeLessThanOrEqual(SETTLE_BUDGET_MS);
    expect(batches.reduce((total, batch) => total + batch.ticks, 0)).toBe(180);
  });

  test("still advances when a single tick outruns the whole budget", () => {
    const { sim, state, now } = fakeSim(SETTLE_BUDGET_MS * 3);
    const scheduler = heldScheduler();
    let settled = 0;

    settleSimulation(sim, { ticks: 12, now, schedule: scheduler.schedule, onSettled: () => (settled += 1) });

    expect(state.ticks).toBe(1);
    // One tick per batch, so 12 ticks take the first batch plus 11 yields.
    expect(scheduler.flush()).toBe(11);
    expect(state.ticks).toBe(12);
    expect(settled).toBe(1);
  });

  test("cancelling drops the queued batch and never settles", () => {
    const { sim, state, now } = fakeSim(1);
    const scheduler = heldScheduler();
    let settled = 0;

    const cancel = settleSimulation(sim, {
      ticks: 180,
      now,
      schedule: scheduler.schedule,
      onSettled: () => (settled += 1),
    });
    const ticksAtCancel = state.ticks;
    cancel();

    expect(scheduler.queue).toHaveLength(0);
    expect(scheduler.flush()).toBe(0);
    expect(state.ticks).toBe(ticksAtCancel);
    expect(settled).toBe(0);
  });

  test("a batch that fires after cancel does not tick", () => {
    const { sim, state, now } = fakeSim(1);
    const queue: Array<() => void> = [];
    let settled = 0;
    // A scheduler whose canceller cannot unqueue: the timer already fired.
    const cancel = settleSimulation(sim, {
      ticks: 180,
      now,
      schedule: (run) => {
        queue.push(run);
        return () => {};
      },
      onSettled: () => (settled += 1),
    });
    const ticksAtCancel = state.ticks;
    cancel();
    queue.shift()!();

    expect(state.ticks).toBe(ticksAtCancel);
    expect(state.stops).toBe(1);
    expect(settled).toBe(0);
  });
});

const NOTES: VaultNoteMeta[] = Array.from({ length: 40 }, (_, i) => ({
  path: `Notes/note-${i}.md`,
  title: `Note ${i}`,
  linksOut: [],
}));
const LINKS: VaultLink[] = NOTES.flatMap((note, i) =>
  [1, 5, 11].map((step) => ({ source: note.path, target: NOTES[(i + step) % NOTES.length]!.path })),
);

/** The component's exact force configuration, over a fresh graph model. */
function buildSimulation() {
  const model = computeGraphModel(NOTES, LINKS);
  const sim = forceSimulation<VaultGraphNode>(model.nodes)
    .force(
      "link",
      forceLink<VaultGraphNode, VaultGraphEdge>(model.links)
        .id((d) => d.id)
        .distance(55)
        .strength(0.35),
    )
    .force("charge", forceManyBody<VaultGraphNode>().strength(-140))
    .force("center", forceCenter(600, 360))
    .force(
      "collide",
      forceCollide<VaultGraphNode>().radius((d) => nodeRadius(d.degree) + 3),
    )
    .alphaDecay(0.045);
  return { model, sim };
}

describe("settleSimulation layout equivalence", () => {
  test("the batched layout is the fully settled layout even across timer turns", async () => {
    const positionsOf = (nodes: VaultGraphNode[]) => nodes.map((node) => `${node.x?.toFixed(9)},${node.y?.toFixed(9)}`);

    const synchronous = (() => {
      const { model, sim } = buildSimulation();
      sim.tick(180);
      sim.stop();
      return positionsOf(model.nodes);
    })();

    const batched = await (async () => {
      const { model, sim } = buildSimulation();
      const scheduler = heldScheduler();
      let settled = false;
      settleSimulation(sim, {
        ticks: 180,
        budgetMs: 0, // one tick per batch: the most fragmented settle possible.
        schedule: scheduler.schedule,
        onSettled: () => (settled = true),
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(scheduler.flush()).toBe(179);
      expect(settled).toBe(true);
      return positionsOf(model.nodes);
    })();

    expect(batched).toEqual(synchronous);
    expect(batched).toHaveLength(NOTES.length);
    expect(batched.every((position) => /^-?\d+\.\d{9},-?\d+\.\d{9}$/.test(position))).toBe(true);
  });
});

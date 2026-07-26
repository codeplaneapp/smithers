import { initialTransition, transition } from "xstate";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { stableHash } from "./stableHash.js";

/** @typedef {import("./FoldEvent.ts").FoldEvent} FoldEvent */

/**
 * Order collected events into the fold's total order:
 * (provenance seq, declaration index, mapped-event subindex).
 * Causal arrival order first, deterministic tiebreaks after — a pure
 * function of rows on every branch, in every process.
 * @param {FoldEvent[]} events
 * @returns {FoldEvent[]}
 */
export function orderFoldEvents(events) {
  return [...events].sort(
    (a, b) => a.seq - b.seq || a.declarationIndex - b.declarationIndex || a.subIndex - b.subIndex,
  );
}

/**
 * Pure fold: `initialTransition(machine, input)` then one
 * `transition(machine, snapshot, event)` per ordered event. Both return
 * `[snapshot, actions]`; actions are discarded (builtin `assign` applies
 * inside `transition` itself). Events arriving after the machine leaves
 * `active` status are discarded, matching live-actor semantics. Any snapshot
 * that acquires children means `spawn` ran inside an `assign` — rejected
 * with a typed error (the mount lint cannot see runtime spawns).
 *
 * @param {import("xstate").AnyStateMachine} machine
 * @param {{ id: string; input?: unknown; events: FoldEvent[]; startAt?: { snapshot: import("xstate").AnyMachineSnapshot; alreadyFolded: number } }} options
 * @returns {{ snapshot: import("xstate").AnyMachineSnapshot; folded: number }}
 */
export function foldMachineState(machine, options) {
  const events = options.events;
  let snapshot;
  let start = 0;
  if (options.startAt) {
    snapshot = options.startAt.snapshot;
    start = options.startAt.alreadyFolded;
  } else {
    try {
      [snapshot] = initialTransition(machine, /** @type {any} */ (options.input));
    } catch (cause) {
      throw new SmithersError(
        "XSTATE_FOLD_FAILED",
        `Machine "${options.id}" failed in initialTransition: ${cause instanceof Error ? cause.message : String(cause)}`,
        { machineId: options.id, phase: "initialTransition" },
        { cause },
      );
    }
    rejectSpawnedChildren(options.id, snapshot, null);
  }
  let folded = start;
  for (let i = start; i < events.length; i++) {
    const event = events[i];
    if (snapshot.status !== "active") {
      // Post-final (or errored) machine: remaining events are discarded
      // deterministically. They still count as folded so the prefix
      // cache stays content-validated over the full event list.
      folded = events.length;
      break;
    }
    try {
      [snapshot] = transition(machine, snapshot, /** @type {any} */ (event.event));
    } catch (cause) {
      throw new SmithersError(
        "XSTATE_FOLD_FAILED",
        `Machine "${options.id}" failed folding event "${String(event.event?.type)}" (seq ${event.seq}): ${cause instanceof Error ? cause.message : String(cause)}`,
        { machineId: options.id, eventType: String(event.event?.type), seq: event.seq },
        { cause },
      );
    }
    rejectSpawnedChildren(options.id, snapshot, event);
    folded = i + 1;
  }
  return { snapshot, folded };
}

/**
 * @param {string} id
 * @param {import("xstate").AnyMachineSnapshot} snapshot
 * @param {FoldEvent | null} event
 */
function rejectSpawnedChildren(id, snapshot, event) {
  if (snapshot.children && Object.keys(snapshot.children).length > 0) {
    throw new SmithersError(
      "XSTATE_SPAWN_UNSUPPORTED",
      `Machine "${id}" spawned a child actor${event ? ` while folding event "${String(event.event?.type)}"` : " during its initial transition"}. Spawned actors cannot run inside a durable fold — execute work with a Smithers <Task> and feed its output back with the taskOutput() event source.`,
      { machineId: id, eventType: event ? String(event.event?.type) : null },
    );
  }
}

/**
 * Content hashes for the prefix cache: one hash per ordered event. The cache
 * validates by CONTENT, never by (count, maxSeq) — an in-place payload
 * replacement at the same (nodeId, iteration) keeps its seq but must
 * invalidate the folded prefix from that position.
 * @param {FoldEvent[]} events
 * @returns {string[]}
 */
export function hashFoldEvents(events) {
  return events.map((event) => stableHash([event.seq, event.declarationIndex, event.subIndex, event.event]));
}

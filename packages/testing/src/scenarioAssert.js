// src/runEffect.ts
async function runMaybeEffect(value) {
  if (value == null) {
    return value;
  }
  if (typeof value.then === "function") {
    return value;
  }
  const { Effect } = await import("effect");
  if (Effect.isEffect(value)) {
    return Effect.runPromise(value);
  }
  return value;
}

// src/scenarioAssert.ts
async function listNodes(adapter, runId) {
  const rows = await runMaybeEffect(adapter.listNodes(runId));
  return Array.isArray(rows) ? rows : [];
}
async function listEventsByType(adapter, runId, type) {
  if (!adapter.listEventsByType) return [];
  const rows = await runMaybeEffect(adapter.listEventsByType(runId, type));
  return (rows ?? []).map((row) => {
    try {
      return JSON.parse(String(row.payloadJson ?? "{}"));
    } catch {
      return {};
    }
  });
}
async function expectRunStatus(adapter, runId, status) {
  if (!adapter.getRun) {
    throw new Error("adapter.getRun required for expectRunStatus");
  }
  const run = await runMaybeEffect(adapter.getRun(runId));
  const actual = run?.status;
  if (actual !== status) {
    throw new Error(`Expected run status ${status}, got ${String(actual)}`);
  }
}
async function expectNodeState(adapter, runId, nodeId, state) {
  const nodes = await listNodes(adapter, runId);
  const node = nodes.find((n) => n.nodeId === nodeId);
  if (!node) {
    throw new Error(`Node ${nodeId} not found in run ${runId} (nodes: ${nodes.map((n) => n.nodeId).join(",")})`);
  }
  if (node.state !== state) {
    throw new Error(`Expected node ${nodeId} state ${state}, got ${String(node.state)}`);
  }
}
async function expectNodeStates(adapter, runId, expected) {
  for (const [nodeId, state] of Object.entries(expected)) {
    await expectNodeState(adapter, runId, nodeId, state);
  }
}
async function tallyNodeStates(adapter, runId) {
  const nodes = await listNodes(adapter, runId);
  const t = { working: 0, failed: 0, done: 0, blocked: 0, other: 0, total: nodes.length };
  for (const n of nodes) {
    switch (n.state) {
      case "in-progress":
        t.working += 1;
        break;
      case "failed":
      case "stalled":
        t.failed += 1;
        break;
      case "finished":
        t.done += 1;
        break;
      case "waiting-approval":
      case "waiting-event":
      case "waiting-timer":
      case "waiting-quota":
      case "bound":
      case "waiting-bound":
      case "bound-stale":
        t.blocked += 1;
        break;
      default:
        t.other += 1;
    }
  }
  return t;
}
async function expectSteerConsumed(adapter, runId, opts) {
  if (!adapter.listSteers) {
    throw new Error("adapter.listSteers required for expectSteerConsumed");
  }
  const steers = await runMaybeEffect(adapter.listSteers(runId));
  const consumed = (steers ?? []).filter((n) => n.status === "consumed");
  const filtered = opts?.nodeId ? consumed.filter((n) => n.nodeId === opts.nodeId) : consumed;
  const min = opts?.minCount ?? 1;
  if (filtered.length < min) {
    throw new Error(
      `Expected at least ${min} consumed steer(s)${opts?.nodeId ? ` for ${opts.nodeId}` : ""}, got ${filtered.length}`
    );
  }
  if (!adapter.listEventsByType) {
    throw new Error("adapter.listEventsByType required for expectSteerConsumed");
  }
  const events = await listEventsByType(adapter, runId, "SteerConsumed");
  if (events.length < min) {
    throw new Error(`Expected SteerConsumed events >= ${min}, got ${events.length}`);
  }
}
async function expectEventCount(adapter, runId, type, count) {
  if (!adapter.listEventsByType) throw new Error("adapter.listEventsByType required for expectEventCount");
  const events = await listEventsByType(adapter, runId, type);
  if (events.length !== count) {
    throw new Error(`Expected ${count} ${type} event(s), got ${events.length}`);
  }
}
function expectSoftPinBoard(openedNodeIds, opts = {}) {
  const workerRe = opts.workerPattern ?? /(?:^|[/:._-])(?:worker|fix|shard|leaf|item)[-_]?\d+$/i;
  const maxStages = opts.maxStages ?? 1;
  const allowedFailWorkers = new Set(opts.mustInclude ?? []);
  const workers = openedNodeIds.filter((id) => workerRe.test(id));
  const stages = openedNodeIds.filter((id) => !workerRe.test(id) && !id.startsWith("gate:"));
  const unexpectedWorkers = workers.filter((w) => !allowedFailWorkers.has(w));
  if (unexpectedWorkers.length > 0) {
    throw new Error(`Workers should stay board-only, opened: ${unexpectedWorkers.join(", ")}`);
  }
  if (stages.length > maxStages) {
    throw new Error(`Expected at most ${maxStages} stage tab(s), opened: ${stages.join(", ")}`);
  }
  for (const id of opts.mustInclude ?? []) {
    if (!openedNodeIds.includes(id)) {
      throw new Error(`Expected opened tab ${id}, got [${openedNodeIds.join(", ")}]`);
    }
  }
  for (const id of opts.mustExclude ?? []) {
    if (openedNodeIds.includes(id)) {
      throw new Error(`Expected no tab for ${id}`);
    }
  }
}
export {
  expectEventCount,
  expectNodeState,
  expectNodeStates,
  expectRunStatus,
  expectSoftPinBoard,
  expectSteerConsumed,
  tallyNodeStates
};

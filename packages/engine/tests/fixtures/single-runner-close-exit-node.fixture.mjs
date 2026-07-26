// #1378 repro, under PLAIN NODE: the non-Bun branch of buildRunnerLayer
// assembles the same Sharding stack over MessageStorage.layerMemory, so it
// forks the same event-loop-pinning daemon fibers and needs the same teardown.
//
// This dispatches one real worker task (dispatchWorkerTask is the sole opener
// of the runtime), closes the runtime, and must exit ON ITS OWN. There is
// deliberately NO process.exit(); that is the entire point. It skips the
// workflow store on purpose so the only thing keeping the loop alive is the
// cluster runtime under test.
//
// Spawned by ../single-runner-close-exit.test.js.
import { closeSingleRunnerRuntime, dispatchWorkerTask } from "../../src/effect/single-runner.js";

const task = {
  executionId: `node-close-exit-${process.pid}`,
  bridgeKey: `node-close-exit-${process.pid}`,
  workflowName: "single-runner-close-exit-node",
  runId: `single-runner-close-exit-node-${process.pid}`,
  nodeId: "node",
  iteration: 0,
  retries: 0,
  taskKind: "compute",
  dispatchKind: "compute",
};

async function main() {
  if (typeof Bun !== "undefined") {
    throw new Error("fixture must run under plain node, but Bun is defined");
  }
  const result = await dispatchWorkerTask(task, async () => ({ terminal: true }));
  if (result?.terminal !== true) {
    throw new Error(`unexpected dispatch result: ${JSON.stringify(result)}`);
  }
  console.log("DISPATCH_FINISHED");
  await closeSingleRunnerRuntime();
  console.log("RUNTIME_CLOSED");
}

try {
  await main();
} catch (error) {
  console.error(`FAIL: ${error?.stack ?? error}`);
  process.exitCode = 1;
}
// No process.exit(): the event loop must drain by itself.

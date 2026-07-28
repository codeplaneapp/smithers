/** @param {string} runId */
export function oneshotCta(runId) {
  return {
    description:
      "Operate the oneshot run. If you are assisting a user, offer to launch the monitor so they can watch, steer, or restart it:",
    commands: [
      { command: `monitor ${runId}`, description: "Open the live monitor with steer and restart controls" },
      { command: `ui ${runId}`, description: "Open the live oneshot UI" },
      { command: `chat ${runId}`, description: "Read the agent transcript" },
      { command: `hijack ${runId}`, description: "Take over the agent session" },
      { command: `pause ${runId}`, description: "Pause the run" },
      { command: `cancel ${runId}`, description: "Cancel the run" },
    ],
  };
}

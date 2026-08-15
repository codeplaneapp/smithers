/** @param {string} value */
function shellQuote(value) {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * @param {string} runId
 * @param {string} [cwd]
 */
export function oneshotCta(runId, cwd) {
  const cwdFlag = cwd ? ` --cwd ${shellQuote(cwd)}` : "";
  return {
    description:
      "Operate the oneshot run" +
      (cwd ? ` in workspace ${cwd}` : "") +
      ". If you are assisting a user, offer to launch the monitor so they can watch, steer, or restart it:",
    commands: [
      { command: `monitor ${runId}${cwdFlag}`, description: "Open the live monitor with steer and restart controls" },
      { command: `status ${runId}${cwdFlag}`, description: "Check run health" },
      { command: `inspect ${runId}${cwdFlag}`, description: "Inspect full run state" },
      { command: `ui ${runId}${cwdFlag}`, description: "Open the live oneshot UI" },
      { command: `chat ${runId}${cwdFlag}`, description: "Read the agent transcript" },
      { command: `hijack ${runId}${cwdFlag}`, description: "Take over the agent session" },
      { command: `pause ${runId}${cwdFlag}`, description: "Pause the run" },
      { command: `cancel ${runId}${cwdFlag}`, description: "Cancel the run" },
    ],
  };
}

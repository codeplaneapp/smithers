import React from "react";

export type ContinueAsNewProps = {
  /**
   * Optional JSON-serializable state carried into the new run.
   */
  state?: unknown;
};

function serializeState(state: unknown): string | undefined {
  if (state === undefined) return undefined;
  return JSON.stringify(state);
}

export function ContinueAsNew(props: ContinueAsNewProps) {
  return React.createElement("smithers:continue-as-new", {
    stateJson: serializeState(props.state),
  });
}

/**
 * Convenience helper for conditional continuation inside workflow JSX:
 * `{shouldContinue ? continueAsNew({ cursor }) : null}`
 */
export function continueAsNew(state?: unknown) {
  return React.createElement(ContinueAsNew, { state });
}

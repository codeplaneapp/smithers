// @smithers-type-exports-begin
/** @typedef {import("./DebateProps.ts").DebateProps} DebateProps */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Parallel } from "./Parallel.js";
import { Loop } from "./Ralph.js";
import { Task } from "./Task.js";
import { useOptionalSmithersContext } from "./useOptionalSmithersContext.js";
/**
 * <Debate> — Adversarial rounds with rebuttals, followed by a judge verdict.
 *
 * Composes: Sequence > Loop[Parallel(proposer, opponent)] > Task(judge)
 * @param {DebateProps} props
 */
export function Debate(props) {
  if (props.skipIf) return null;
  const { id, proposer, opponent, judge, rounds = 2, argumentOutput, verdictOutput, topic } = props;
  const prefix = id ?? "debate";
  const ctx = useOptionalSmithersContext();
  // Build round tasks inside a loop
  // Each round: proposer and opponent argue in parallel
  const proposerTask = React.createElement(Task, {
    id: `${prefix}-proposer`,
    output: argumentOutput,
    agent: proposer,
    label: "Proposer",
    children: React.createElement(React.Fragment, null, "Argue FOR the following topic:\n\n", topic),
  });
  const opponentTask = React.createElement(Task, {
    id: `${prefix}-opponent`,
    output: argumentOutput,
    agent: opponent,
    label: "Opponent",
    children: React.createElement(React.Fragment, null, "Argue AGAINST the following topic:\n\n", topic),
  });
  const roundParallel = React.createElement(Parallel, null, proposerTask, opponentTask);
  const roundSequence = React.createElement(Sequence, null, roundParallel);
  // Loop wraps the round sequence. `until` stays false: a Debate runs a fixed
  // number of adversarial rounds (capped by maxIterations), with no early-exit
  // condition — the judge rules once all rounds are done.
  const loopEl = React.createElement(
    Loop,
    {
      id: `${prefix}-loop`,
      until: false,
      maxIterations: rounds,
      onMaxReached: "return-last",
    },
    roundSequence,
  );
  // Judge verdict after all rounds. The proposer/opponent arguments live inside
  // the loop, so fold the most recent round's outputs into the judge's prompt
  // via `latest` (the reader that resolves the newest iteration's rows); `needs`
  // alone is cache-context only and injects no argument text.
  const judgeNeeds = {
    [`${prefix}-proposer`]: `${prefix}-proposer`,
    [`${prefix}-opponent`]: `${prefix}-opponent`,
  };
  const latestProposer = ctx?.latest?.(argumentOutput, `${prefix}-proposer`);
  const latestOpponent = ctx?.latest?.(argumentOutput, `${prefix}-opponent`);
  const judgeTask = React.createElement(Task, {
    id: `${prefix}-judge`,
    output: verdictOutput,
    agent: judge,
    needs: judgeNeeds,
    label: "Judge",
    children: () =>
      React.createElement(
        React.Fragment,
        null,
        "Review all arguments from both sides and render a verdict on:\n\n",
        topic,
        "\n\n## Proposer's arguments\n",
        latestProposer ? JSON.stringify(latestProposer) : "(no arguments)",
        "\n\n## Opponent's arguments\n",
        latestOpponent ? JSON.stringify(latestOpponent) : "(no arguments)",
      ),
  });
  return React.createElement(Sequence, null, loopEl, judgeTask);
}

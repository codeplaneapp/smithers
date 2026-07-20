// @smithers-type-exports-begin
/** @typedef {import("./SidecarProps.ts").SidecarProps} SidecarProps */
// @smithers-type-exports-end

import React from "react";
import { Parallel } from "./Parallel.js";
import { Task } from "./Task.js";

/**
 * Runs a primary task and a cheap shadow task over the same prompt.
 *
 * The primary task keeps the component id so downstream `needs` can consume it.
 * The sidecar task is continue-on-fail and writes its own scorer rows.
 *
 * @param {SidecarProps} props
 */
export function Sidecar(props) {
	if (props.skipIf) return null;
	const {
		id = "sidecar",
		agent,
		sidecar,
		output,
		sidecarOutput,
		scorers,
		prompt,
		input,
		maxConcurrency,
		groundTruth,
		context,
		primaryLabel,
		sidecarLabel,
		children,
	} = props;
	const promptNode = prompt ?? input ?? children;
	const shadowId = `${id}-sidecar`;
	return React.createElement(
		Parallel,
		{ id: `${id}-parallel`, maxConcurrency },
		React.createElement(
			Task,
			{
				id,
				output,
				agent,
				scorers,
				groundTruth,
				context,
				label: primaryLabel,
			},
			promptNode,
		),
		React.createElement(
			Task,
			{
				id: shadowId,
				output: sidecarOutput ?? output,
				agent: sidecar,
				continueOnFail: true,
				scorers,
				groundTruth,
				context,
				label: sidecarLabel,
			},
			promptNode,
		),
	);
}

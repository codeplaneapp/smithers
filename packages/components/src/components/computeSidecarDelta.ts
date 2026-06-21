import type { SidecarDelta } from "./SidecarDelta.ts";

type RowLike = {
	nodeId?: string;
	node_id?: string;
	scorerId?: string;
	scorer_id?: string;
	score?: number;
	scoredAtMs?: number;
	scored_at_ms?: number;
} & Record<string, unknown>;

type ComputeSidecarDeltaOptions = {
	primaryNodeId: string;
	sidecarNodeId: string;
	scorerId?: string;
};

function getNodeId(row: RowLike): string | undefined {
	return typeof row.nodeId === "string" ? row.nodeId : typeof row.node_id === "string" ? row.node_id : undefined;
}

function getScorerId(row: RowLike): string | undefined {
	return typeof row.scorerId === "string"
		? row.scorerId
		: typeof row.scorer_id === "string"
			? row.scorer_id
			: undefined;
}

function getScoredAtMs(row: RowLike): number {
	const value = row.scoredAtMs ?? row.scored_at_ms;
	return typeof value === "number" ? value : 0;
}

function getScore(row: RowLike | undefined): number | null {
	return typeof row?.score === "number" ? row.score : null;
}

function latestMatching(rows: RowLike[], nodeId: string, scorerId?: string): RowLike | undefined {
	return rows
		.filter((row) => getNodeId(row) === nodeId && (!scorerId || getScorerId(row) === scorerId))
		.sort((a, b) => getScoredAtMs(b) - getScoredAtMs(a))[0];
}

export function computeSidecarDelta(rows: RowLike[], opts: ComputeSidecarDeltaOptions): SidecarDelta {
	const primaryScore = getScore(latestMatching(rows, opts.primaryNodeId, opts.scorerId));
	const sidecarScore = getScore(latestMatching(rows, opts.sidecarNodeId, opts.scorerId));
	const delta =
		primaryScore == null || sidecarScore == null ? null : Number((primaryScore - sidecarScore).toFixed(12));
	return {
		primaryScore,
		sidecarScore,
		delta,
		cheaperWins: primaryScore != null && sidecarScore != null && sidecarScore >= primaryScore,
	};
}

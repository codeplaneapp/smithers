export type SidecarDelta = {
	primaryScore: number | null;
	sidecarScore: number | null;
	delta: number | null;
	cheaperWins: boolean;
};

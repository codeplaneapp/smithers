export type RunStatusSchema =
	| "running"
	| "waiting-approval"
	| "waiting-event"
	| "waiting-timer"
	| "waiting-quota"
	| "finished"
	| "continued"
	| "failed"
	| "cancelled";

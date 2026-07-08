export type TaskTraceContext = {
	workflowPath: string | null;
	workflowHash: string | null;
	logDir?: string | undefined;
	annotations?: Record<string, string | number | boolean> | undefined;
};

/**
 * Best-effort CloudWatch Logs reader. Concatenates the events of one log stream
 * into a single string, truncated to `maxOutputBytes`. Any failure resolves to
 * an empty string so log capture never breaks a run.
 *
 * @param {{
 *   logs: { getLogEvents: (input: Record<string, unknown>) => Promise<any> } | undefined;
 *   logGroupName?: string;
 *   logStreamName?: string;
 *   maxOutputBytes?: number;
 *   signal?: AbortSignal;
 * }} config
 * @returns {Promise<string>}
 */
export async function readCloudWatchLogs(config) {
	const { logs, logGroupName, logStreamName } = config;
	if (!logs || !logGroupName || !logStreamName) return "";
	try {
		const res = await logs.getLogEvents(
			{
				logGroupName,
				logStreamName,
				startFromHead: true,
			},
			{ abortSignal: config.signal },
		);
		const events = /** @type {{ events?: Array<{ message?: unknown }> }} */ (res)?.events ?? [];
		const text = events.map((event) => String(event?.message ?? "")).join("");
		const maxBytes = config.maxOutputBytes;
		if (Number.isFinite(maxBytes) && /** @type {number} */ (maxBytes) > 0 && text.length > /** @type {number} */ (maxBytes)) {
			const kept = text.slice(0, /** @type {number} */ (maxBytes));
			return `${kept}… [truncated ${text.length - /** @type {number} */ (maxBytes)} chars]`;
		}
		return text;
	} catch (error) {
		// Cancellation is control flow, not a best-effort logging failure. Let the
		// runner turn it into its provider-specific cancellation error.
		if (config.signal?.aborted) throw error;
		return "";
	}
}

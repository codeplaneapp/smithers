import type { DelegationSharedProps } from "./DelegationSharedProps.ts";

export type DelegationEditListenerProps = DelegationSharedProps & {
	/**
	 * Stop listening when true (unmounts the armed signal wait so the run can
	 * finish). DelegationChain flips this once scoring completes; standalone
	 * callers compute their own condition.
	 */
	until?: boolean;
	/** Max live edits accepted in one run (default 25). */
	maxEdits?: number;
};

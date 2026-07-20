import type { DelegationSharedProps } from "./DelegationSharedProps.ts";

export type DelegationExecutionProps = DelegationSharedProps & {
	/** Max exec/review attempts per leaf (default 3). Attempt = loop iteration. */
	maxAttempts?: number;
};

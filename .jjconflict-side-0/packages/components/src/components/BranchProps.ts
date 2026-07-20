import type React from "react";

export type BranchProps = {
	if: boolean;
	then: React.ReactElement;
	else?: React.ReactElement | null;
	skipIf?: boolean;
	/**
	 * `<Branch>` resolves its subtree from `then`/`else`; it takes no children.
	 * Typed as `never` so passing JSX children is a compile-time error (the
	 * runtime also throws — children would otherwise be silently dropped).
	 */
	children?: never;
};

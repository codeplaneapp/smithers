import type React from "react";

export type LoopProps = {
	key?: string;
	id?: string;
	until?: boolean;
	maxIterations?: number;
	onMaxReached?: "fail" | "return-last";
	continueAsNewEvery?: number;
	skipIf?: boolean;
	children?: React.ReactNode;
};

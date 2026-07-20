import type {
	ApprovalProps,
	InferDeps,
	SignalProps,
	TaskProps,
} from "../index.js";
import type { z } from "zod";

type IsAny<T> = 0 extends 1 & T ? true : false;
type AssertFalse<T extends false> = T;

type _ApprovalPropsIsNotAny = AssertFalse<IsAny<ApprovalProps>>;
type _InferDepsIsNotAny = AssertFalse<IsAny<InferDeps<{ upstream: string }>>>;
type _SignalPropsIsNotAny = AssertFalse<
	IsAny<SignalProps<z.ZodObject<{ value: z.ZodString }>>>
>;
type _TaskPropsIsNotAny = AssertFalse<IsAny<TaskProps<unknown>>>;

// @ts-expect-error TaskProps requires an id.
const invalidTaskProps: TaskProps<unknown> = { output: "result" };

import type {
  ApprovalDecision,
  ApprovalProps as ComponentApprovalProps,
  DepsSpec,
  InferDeps as ComponentInferDeps,
  OutputTarget,
  SignalProps as ComponentSignalProps,
  TaskProps as ComponentTaskProps,
} from "@smthrs/components";
import type { z } from "zod";

export * from "./index.js";

export type ApprovalProps<Row = ApprovalDecision, Output extends OutputTarget = OutputTarget> = ComponentApprovalProps<
  Row,
  Output
>;

export type InferDeps<D extends DepsSpec> = ComponentInferDeps<D>;

export type SignalProps<Schema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> =
  ComponentSignalProps<Schema>;

export type TaskProps<Row, Output extends OutputTarget = OutputTarget, D extends DepsSpec = {}> = ComponentTaskProps<
  Row,
  Output,
  D
>;

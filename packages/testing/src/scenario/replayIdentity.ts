import { createHash } from "node:crypto";
import { canonicalize } from "./canonicalize.ts";
import type { ScenarioAst } from "./ast.ts";
import type { ControlMessage } from "../control/ControlMessage.ts";
export const replayIdentity = (input: {
  ast: ScenarioAst;
  seed: number;
  controlLog?: readonly ControlMessage[];
}): string =>
  "ri1:" +
  createHash("sha256")
    .update(canonicalize({ ast: input.ast, seed: input.seed, controlLog: input.controlLog ?? [] }))
    .digest("hex");

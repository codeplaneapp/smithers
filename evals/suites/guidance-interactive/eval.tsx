/** @jsxImportSource smthrs */
// guidance-interactive — when an agent hands a human a copy-paste command, does
// it follow the docs' "hand humans interactive commands" rule and include the
// `--interactive` flag where supported? Verify is deterministic `contains`
// (must include --interactive, must not hand the human a detached run).
import { createFluencyEval } from "../../lib/eval-kit";

export default createFluencyEval({ suite: "guidance-interactive" });

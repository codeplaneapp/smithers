import { registerNodeWorkflowLoader } from "./registerNodeWorkflowLoader.js";

// Side-effect entry for `node --import`. The CLI re-execs itself (and spawns
// detached run processes) through a fresh Node process, and module hooks do not
// survive a spawn, so each child has to install them before its own entry file
// is loaded. `--import` is the only hook point early enough to do that.
registerNodeWorkflowLoader();

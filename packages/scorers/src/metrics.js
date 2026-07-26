// Backs the package's `./metrics` subpath export (see package.json) and gives run-scorers.js
// a local import, so consumers read scorer metrics without depending on
// @smithers-orchestrator/observability directly.
export {
  scorerDuration,
  scorersFailed,
  scorersFinished,
  scorersStarted,
} from "@smithers-orchestrator/observability/metrics";

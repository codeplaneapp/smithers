// Backs the package's `./metrics` subpath export (see package.json) and gives run-scorers.js
// a local import, so consumers read scorer metrics without depending on
// @smthrs/observability directly.
export { scorerDuration, scorersFailed, scorersFinished, scorersStarted } from "@smthrs/observability/metrics";

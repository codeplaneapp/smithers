// The single run-id shape every read path validates against. `smithers up
// --run-id` puts no shape constraint on the id it creates, so anything this
// rejects is a run the operator can start but never read back — dotted ids
// such as `orchb-r1-vbt-1.2.0-roadmap` used to fail here while `inspect`,
// `status`, `events` and `scores` all worked.
//
// The first character may not be a dot, which keeps `.` and `..` out of ids
// that downstream code joins into workspace paths; `/` and `\` stay excluded
// for the same reason.
//
// Quoted verbatim in every route's InvalidRunId message. Engine-minted child
// ids append one or more deterministic `:child:<node>:<iteration>` segments;
// the lookahead keeps both operator and child ids within the DB's 256-char
// boundary while the first alternative retains the 64-char operator-id cap.
export const RUN_ID_PATTERN =
  /^(?=.{1,256}$)(?:[a-z0-9_-][a-z0-9_.-]{0,63}|[a-z0-9_-][a-z0-9_.-]{0,255}(?::child:[A-Za-z0-9_.@-]+:[0-9]+)+)$/;

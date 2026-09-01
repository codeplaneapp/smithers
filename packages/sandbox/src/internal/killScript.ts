/**
 * Builds the guest-side descendant signalling script.
 *
 * @since 0.1.0
 */

/** How long the script waits for a newly started command to record its pid. */
const pidfileWaitSeconds = 5

/**
 * Builds a POSIX shell script that signals one recorded pid and all of its
 * descendants, children first.
 *
 * @category constructors
 * @since 0.1.0
 */
export const killScript = (pidfile: string, signal: string): string =>
  `n=0; while [ ! -s ${pidfile} ] && [ "$n" -lt ${pidfileWaitSeconds} ]; do sleep 1; n=$((n+1)); done; ` +
  `p=$(cat ${pidfile} 2>/dev/null) || exit 0; [ -n "$p" ] || exit 0; ` +
  `kids() { for d in /proc/[0-9]*; do read -r _ _ _ pp _ < "$d/stat" 2>/dev/null || continue; ` +
  `[ "$pp" = "$1" ] || continue; c=\${d#/proc/}; ( kids "$c" ); echo "$c"; done; }; ` +
  `for k in $(kids "$p"); do kill -s ${signal} "$k" 2>/dev/null; done; ` +
  `kill -s ${signal} "$p" 2>/dev/null; exit 0`

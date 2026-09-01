/**
 * Builds the descendant signalling scripts.
 *
 * @since 0.1.0
 */

/** How long the script waits for a newly started command to record its pid. */
const pidfileWaitSeconds = 5

/**
 * A `kids` function that prints every descendant of a pid by walking
 * `/proc` — the one enumeration a minimal Linux machine is guaranteed to
 * serve. The parent pid is parsed from the text after the *last* `)` in
 * `/proc/N/stat`, because the comm field before it may itself contain spaces
 * (`(tmux: server)`) and a positional `read` would misparse it and skip that
 * whole subtree. Recursion runs in a subshell so an inner call cannot clobber
 * the caller's variables.
 */
const procKids = `kids() { t=$1; for d in /proc/[0-9]*; do read -r s 2>/dev/null < "$d/stat" || continue; ` +
  `r=\${s##*) }; set -- $r; [ "$2" = "$t" ] || continue; ` +
  `c=\${d#/proc/}; ( kids "$c" ); echo "$c"; done; }`

/** A `kids` function on `pgrep -P`, for hosts with no `/proc` (macOS). */
const pgrepKids = `kids() { for c in $(pgrep -P "$1" 2>/dev/null); do ( kids "$c" ); echo "$c"; done; }`

/**
 * The collect-then-signal tail both scripts share. The whole descendant set
 * is gathered BEFORE anything is signalled and delivered together with the
 * root in one `kill` invocation: killing children one at a time before their
 * parent lets a respawning parent (`while :; do work; done`) replace each
 * child in the gap. The batch `kill` fails if any single collected pid
 * vanished first, so the root is retried alone before the honesty check: a
 * signal the root demonstrably took is delivered, and only a `kill` that
 * failed while the root is still alive exits non-zero instead of claiming
 * delivery.
 */
const signalCollected = (signal: string): string =>
  `set -- $(kids "$p") "$p"; ` +
  `kill -s ${signal} "$@" 2>/dev/null && exit 0; ` +
  `kill -s ${signal} "$p" 2>/dev/null && exit 0; ` +
  `kill -0 "$p" 2>/dev/null || exit 0; ` +
  `exit 1`

/**
 * Builds a POSIX shell script that signals one recorded pid and all of its
 * descendants in a single `kill` invocation.
 *
 * This is the guest-side script for Linux guests: it waits for the pidfile
 * the spawned command writes first, then walks `/proc`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const killScript = (pidfile: string, signal: string): string =>
  `n=0; while [ ! -s ${pidfile} ] && [ "$n" -lt ${pidfileWaitSeconds} ]; do sleep 1; n=$((n+1)); done; ` +
  `p=$(cat ${pidfile} 2>/dev/null) || exit 0; [ -n "$p" ] || exit 0; ` +
  `${procKids}; ` +
  signalCollected(signal)

/**
 * Builds a POSIX shell script that signals one live pid and all of its
 * descendants in a single `kill` invocation.
 *
 * This is the host-side counterpart of {@link killScript} for providers whose
 * transport runs on this machine: the pid is already known, so there is no
 * pidfile to wait for. The descent runs on `pgrep -P` where it exists —
 * macOS, procps Linux, and busybox alike — and otherwise on the `/proc`
 * walk, because the only hosts without `pgrep` (slim Linux images) are
 * exactly the ones with `/proc`; degrading to signalling the root alone
 * would be the silent leak this script exists to close.
 *
 * @category constructors
 * @since 0.1.0
 */
export const hostKillScript = (pid: number, signal: string): string =>
  `p=${pid}; ` +
  `if command -v pgrep >/dev/null 2>&1; then ${pgrepKids}; else ${procKids}; fi; ` +
  signalCollected(signal)

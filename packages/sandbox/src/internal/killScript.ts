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
 * The path a kill writes when the command it meant to stop has not recorded a
 * pid yet.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cancelMarker = (pidfile: string): string => `${pidfile}.cancel`

/**
 * The status a wrapper reports when it finds its cancellation marker: the
 * conventional `128 + SIGTERM`, the same number a shell reports for a command
 * a `SIGTERM` actually ended.
 *
 * @category models
 * @since 0.1.0
 */
export const cancelledStatus = 143

/**
 * The guard a spawned wrapper runs between recording its pid and becoming the
 * command.
 *
 * Container, Kubernetes, and ECS all return from `spawn` once the local client
 * starts, which is before the guest wrapper is guaranteed to have run
 * `echo $$ > pidfile`. A kill issued in that window, or on a machine slow
 * enough that the wrapper takes longer than {@link killScript}'s wait to be
 * scheduled at all, had nothing to signal and reported success anyway — so the
 * command started afterwards and ran unsupervised. The marker gives that kill
 * something to latch onto, and this guard is what honors it. The order is
 * pid first, then guard: a kill that reads the pid signals it, and a kill that
 * does not find one leaves the marker this guard is about to read.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cancelGuard = (pidfile: string): string =>
  `if [ -e ${cancelMarker(pidfile)} ]; then exit ${cancelledStatus}; fi`

/**
 * Builds a POSIX shell script that signals one recorded pid and all of its
 * descendants in a single `kill` invocation.
 *
 * This is the guest-side script for Linux guests: it waits for the pidfile
 * the spawned command writes first, then walks `/proc`.
 *
 * A pidfile that never appears is NOT reported as a delivered signal. The
 * script leaves {@link cancelMarker} instead, which {@link cancelGuard} makes
 * the not-yet-started wrapper honor, and only the failure to leave even that
 * exits non-zero.
 *
 * @category constructors
 * @since 0.1.0
 */
export const killScript = (pidfile: string, signal: string): string =>
  `n=0; while [ ! -s ${pidfile} ] && [ "$n" -lt ${pidfileWaitSeconds} ]; do sleep 1; n=$((n+1)); done; ` +
  `p=$(cat ${pidfile} 2>/dev/null); ` +
  `if [ -z "$p" ]; then : > ${cancelMarker(pidfile)} && exit 0; exit 1; fi; ` +
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

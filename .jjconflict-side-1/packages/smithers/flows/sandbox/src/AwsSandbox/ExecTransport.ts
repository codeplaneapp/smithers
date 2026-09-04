/**
 * Defines the command transport an AWS session reaches its task through.
 *
 * @since 0.1.0
 */
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/**
 * The AWS CLI and its Session Manager plugin, over an injected spawner.
 *
 * ECS Exec is two halves. `ExecuteCommand` on the ECS API opens an SSM session
 * and returns its metadata, and that is all `@aws-sdk/client-ecs` implements.
 * The data channel that carries the command's output and exit status is the
 * Session Manager protocol, which the AWS CLI speaks by delegating to
 * `session-manager-plugin`. A session therefore runs commands the way an
 * operator does at a terminal: `aws ecs execute-command --interactive`, driven
 * through the spawner a host injects, so the package still owns no host access
 * and no dependency.
 *
 * Two consequences of that transport are visible to callers and stated here
 * rather than hidden. The session is a pseudo-terminal, so a command's
 * standard error arrives interleaved on standard output and line endings are
 * normalized; file transfer is byte-exact regardless, because it travels as
 * base64. And the plugin exits zero whatever the remote command did, so the
 * provider wraps every command to print its own exit status and reads that
 * back; a session that ends without it is reported as `aborted`, never as
 * success.
 *
 * What this repository can and cannot prove about it: the framing, the
 * sentinel, the byte paths, and the signal walk are exercised against a fake
 * that reproduces the plugin's banner, footer, carriage returns, and zero exit
 * over a real shell. That the ECS agent hands `--command` to the container's
 * `sh` (which is why the provider sends `sh -c '...'`) and the exact command
 * length the SSM document accepts are taken from the service's documented
 * behavior, not from a live cluster run here; `chunkBytes` exists so the
 * latter can be tuned without a code change.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecTransport {
  /** The spawner the AWS CLI runs through. */
  readonly spawner: ChildProcessSpawner["Service"]
  /** The CLI. Default `aws`. */
  readonly program?: string | undefined
  /** Global CLI arguments placed before the subcommand, such as `--profile`. */
  readonly globalArgs?: ReadonlyArray<string> | undefined
  /**
   * The largest slice of a written file carried by one command, in bytes
   * before base64 encoding. File contents ride inside the command line, whose
   * length the SSM document bounds, so a write is split across as many
   * commands as it needs. Default 3072.
   *
   * A whole number of at least 1. It is the increment of the loop that slices
   * a file, so `0`, a negative value, or `NaN` would spin forever or silently
   * truncate the write; acquiring a session validates it and fails with
   * `spawn_error` instead. The upper end belongs to the service: a slice too
   * large for the SSM document's command length fails the write with AWS's own
   * message, and every write costs one remote round trip per slice, so a small
   * value buys nothing but round trips.
   */
  readonly chunkBytes?: number | undefined
}

/**
 * Executes one `Git.Commit` target: stage, gate, message, commit.
 *
 * The sequence is fixed. The whole tree is staged first so the gates check
 * the exact candidate that will be committed. The gates then run through the
 * injected {@link GateRunner}; a red gate refuses the commit with a typed
 * error and creates nothing. The message is the `-m` override when the
 * invoker passed one, the declared fixed text otherwise, or the injected
 * {@link AgentMessage} composition when the declaration names an agent.
 * Only then is the commit created.
 *
 * Both collaborators are interfaces because their real implementations are
 * integration concerns: the real GateRunner is the executor running gate
 * targets against the staged tree, and the real AgentMessage is the
 * workspace agent stack. This module owns the ordering, the git plumbing,
 * and the typed refusals; tests drive it with fakes in a throwaway
 * repository.
 *
 * @since 0.1.0
 */
import * as GitTarget from "@smthrs/targets/GitTarget"
import type * as Target from "@smthrs/targets/Target"
import * as NodeChildProcess from "node:child_process"

/**
 * The refusal codes one commit invocation can fail with.
 *
 * @category models
 * @since 0.1.0
 */
export type ErrorCode =
  | "not_a_git_repository"
  | "nothing_to_commit"
  | "gates_failed"
  | "agent_message_unavailable"
  | "empty_message"
  | "git_failed"

/**
 * One typed commit refusal.
 *
 * @category errors
 * @since 0.1.0
 */
export class GitCommitError extends Error {
  override readonly name = "GitCommitError"
  readonly code: ErrorCode
  /** The per-gate failures behind a `gates_failed` refusal. */
  readonly failures: ReadonlyArray<GateFailure>

  constructor(code: ErrorCode, message: string, failures: ReadonlyArray<GateFailure> = []) {
    super(`${code}: ${message}`)
    this.code = code
    this.failures = failures
  }
}

/**
 * Checks whether a value is a commit refusal.
 *
 * @category guards
 * @since 0.1.0
 */
export const isGitCommitError = (value: unknown): value is GitCommitError => value instanceof GitCommitError

/**
 * One red gate: the gate target's rule id and its failure text.
 *
 * @category models
 * @since 0.1.0
 */
export interface GateFailure {
  readonly target: string
  readonly message: string
}

/**
 * Runs the declared gate targets against the staged candidate tree.
 *
 * The integration binding is the executor: each gate executes (or cache-hits
 * green) against exactly the tree that was just staged. A fake satisfies the
 * interface in tests.
 *
 * @category models
 * @since 0.1.0
 */
export interface GateRunner {
  run(gates: ReadonlyArray<Target.AnyTarget>): Promise<ReadonlyArray<GateFailure>>
}

/**
 * Composes a commit message for an agent-written `message` declaration.
 *
 * The integration binding resolves the named workspace agent and prompts it
 * with the staged diff. A fake satisfies the interface in tests.
 *
 * @category models
 * @since 0.1.0
 */
export interface AgentMessage {
  compose(context: {
    readonly root: string
    readonly agent: string
    readonly stagedDiff: string
  }): Promise<string>
}

/**
 * The created commit.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommitResult {
  readonly sha: string
  readonly message: string
}

/** Maximum staged-diff code units handed to an agent composition. */
const stagedDiffLimit = 200 * 1024

interface GitOutput {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs one git command with no shell, capturing bounded output. */
const git = (root: string, args: ReadonlyArray<string>): Promise<GitOutput> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      [...args],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = error === null
          ? 0
          : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1
        resolve({ exitCode, stdout, stderr })
      }
    )
  })

/** Runs one git command that must succeed. */
const gitOk = async (root: string, args: ReadonlyArray<string>): Promise<GitOutput> => {
  const output = await git(root, args)
  if (output.exitCode !== 0) {
    throw new GitCommitError("git_failed", `git ${args.join(" ")} exited ${output.exitCode}: ${output.stderr.trim()}`)
  }
  return output
}

/**
 * Options accepted by {@link commit}.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommitOptions {
  /** The repository root the commit is created in. */
  readonly root: string
  /** The `Git.Commit` target whose validated attrs drive the invocation. */
  readonly target: Target.AnyTarget
  /** Runs the declared gates against the staged tree. */
  readonly gateRunner: GateRunner
  /** Composes an agent-written message; optional when the message is fixed text. */
  readonly agentMessage?: AgentMessage | undefined
  /** The `-m` override; when present it wins over the declared message. */
  readonly messageOverride?: string | undefined
}

/**
 * Executes one `Git.Commit` invocation: stage, gate, message, commit.
 *
 * @category execution
 * @since 0.1.0
 */
export const commit = async (options: CommitOptions): Promise<CommitResult> => {
  const attrs = GitTarget.commitAttrsOf(options.target)
  const inside = await git(options.root, ["rev-parse", "--is-inside-work-tree"])
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    throw new GitCommitError("not_a_git_repository", `${options.root} is not inside a git work tree`)
  }
  // Stage the whole tree first so the gates and the commit see one candidate.
  await gitOk(options.root, ["add", "-A"])
  const staged = await git(options.root, ["diff", "--cached", "--quiet"])
  if (staged.exitCode === 0) {
    throw new GitCommitError("nothing_to_commit", "the staged tree is identical to HEAD")
  }
  const failures = await options.gateRunner.run(attrs.gates)
  if (failures.length > 0) {
    throw new GitCommitError(
      "gates_failed",
      failures.map((failure) => `${failure.target}: ${failure.message}`).join("; "),
      failures
    )
  }
  let message: string
  if (options.messageOverride !== undefined) {
    message = options.messageOverride
  } else if (typeof attrs.message === "string") {
    message = attrs.message
  } else {
    const agentName = attrs.message._tag === "AgentRef"
      ? attrs.message.name
      : attrs.message._tag === "AgentPool"
      ? attrs.message.agents.join(",")
      : `inline:${attrs.message.model}`
    if (options.agentMessage === undefined) {
      throw new GitCommitError(
        "agent_message_unavailable",
        `the declared message agent ${agentName} has no bound AgentMessage implementation`
      )
    }
    const diff = await gitOk(options.root, ["diff", "--cached"])
    message = await options.agentMessage.compose({
      root: options.root,
      agent: agentName,
      stagedDiff: diff.stdout.slice(0, stagedDiffLimit)
    })
  }
  if (message.trim() === "") {
    throw new GitCommitError("empty_message", "the commit message is empty")
  }
  await gitOk(options.root, ["-c", "commit.gpgsign=false", "commit", "-m", message])
  const sha = await gitOk(options.root, ["rev-parse", "HEAD"])
  return { sha: sha.stdout.trim(), message }
}

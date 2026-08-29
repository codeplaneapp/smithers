/**
 * The shared refusal gate every outward-effect rule runs before it acts.
 *
 * `S.Npm.Publish`, `S.Github.Release`, `S.Github.Pages`, `S.Git.Pr`, and
 * `S.Changesets.Publish` all push bytes to somebody else's machine. They
 * share one contract, so they share one gate rather than five copies of it:
 *
 * - **Never cached.** An outward effect has no result to replay: the second
 *   invocation is a second publish. The rules opt out of the cache in the
 *   package executor and this module exists so the reason is written once.
 * - **Declared secrets.** Each rule names the credential it needs. A
 *   declaration that omits it is refused at plan time, before anything is
 *   spawned, and a declaration that names it but runs in an environment
 *   carrying no value is refused at execution, still before anything is
 *   spawned. Values are read for presence only and never logged.
 * - **Approval.** `approval: "required"` refuses until a durable approval is
 *   granted. Package mode has no approval store, so the refusal is the
 *   honest answer there and the invocation has no side effect to undo.
 *
 * This generalises the `Github.Pr` gate that shipped first; that rule keeps
 * its own named error for compatibility and this module is what every rule
 * added afterwards uses.
 *
 * @since 0.1.0
 */
import type * as Secret from "./Secret.ts"

/**
 * Why one outward invocation was refused.
 *
 * `missing_secret` covers both a declaration that never names the required
 * variable and an environment that carries no value for it.
 * `approval_unsatisfied` covers `approval: "required"` with no granted
 * approval.
 *
 * @category models
 * @since 0.1.0
 */
export type RefusalCode = "missing_secret" | "approval_unsatisfied"

/**
 * An outward invocation was refused before any outward action.
 *
 * @category errors
 * @since 0.1.0
 */
export class Refused extends Error {
  override readonly name = "Refused"
  readonly code: RefusalCode
  readonly rule: string

  constructor(rule: string, code: RefusalCode, message: string) {
    super(`${rule}: ${code}: ${message}`)
    this.code = code
    this.rule = rule
  }
}

/**
 * Checks whether a value is an outward {@link Refused} refusal.
 *
 * @category guards
 * @since 0.1.0
 */
export const isRefused = (value: unknown): value is Refused => value instanceof Refused

/**
 * The facts one outward invocation presents to the gate.
 *
 * @category models
 * @since 0.1.0
 */
export interface Invocation {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly approvalGranted: boolean
}

/**
 * What one outward rule requires before it may act.
 *
 * @category models
 * @since 0.1.0
 */
export interface Requirements {
  /** The rule id, used in the refusal text. */
  readonly rule: string
  /** The environment-variable names the declaration must name and satisfy. */
  readonly required: ReadonlyArray<string>
  /** The secrets the declaration actually names. */
  readonly declared: ReadonlyArray<Secret.Secret> | undefined
  /** The declared approval attr, if any. */
  readonly approval: "required" | undefined
}

/**
 * Returns the refusal one outward invocation earns, or undefined when every
 * precondition is satisfied.
 *
 * Secrets are checked before approval so an author who has declared neither
 * is told about the credential first: it is the one that cannot be granted
 * interactively.
 *
 * @category validation
 * @since 0.1.0
 */
export const refuse = (requirements: Requirements, invocation: Invocation): Refused | undefined => {
  const declared = requirements.declared ?? []
  for (const name of requirements.required) {
    const secret = declared.find((entry) => entry.env === name)
    if (secret === undefined) {
      return new Refused(
        requirements.rule,
        "missing_secret",
        `declares no S.Secret(${JSON.stringify(name)}) in secrets`
      )
    }
    const value = invocation.environment[secret.env]
    if (value === undefined || value === "") {
      return new Refused(
        requirements.rule,
        "missing_secret",
        `the declared ${secret.env} secret has no value in the invoking environment`
      )
    }
  }
  if (requirements.approval === "required" && !invocation.approvalGranted) {
    return new Refused(
      requirements.rule,
      "approval_unsatisfied",
      "declares approval: \"required\" and no approval was granted"
    )
  }
  return undefined
}

/**
 * Runs the gate and refuses everything past it.
 *
 * Passing the gate is not success: the outward action itself is not
 * implemented in package mode, and saying so loudly is the no-fake-green
 * rule. Callers that do implement the action call {@link refuse} instead.
 *
 * @category execution
 * @since 0.1.0
 */
export const act = (requirements: Requirements, invocation: Invocation): never => {
  const refusal = refuse(requirements, invocation)
  if (refusal !== undefined) throw refusal
  throw new Error(
    `NotImplemented: ${requirements.rule} passed its refusal gate, and performing the outward action is not implemented`
  )
}

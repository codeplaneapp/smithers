/**
 * A run that is handed a credential.
 *
 * It runs in its own process so the case can read the child's whole stdout and
 * stderr: a secret that reaches an operator's terminal has leaked exactly as
 * surely as one that reaches the journal.
 *
 * Usage: `node secretChild.ts <filename> <executionId> <secret>`
 */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const [filename, executionId, secret] = process.argv.slice(2)
if (filename === undefined || executionId === undefined || secret === undefined) {
  process.stderr.write("usage: secretChild.ts <filename> <executionId> <secret>\n")
  process.exit(2)
}

const Use = Action.make("e2e/secret/Use", {
  payload: { apiKey: Schema.String, endpoint: Schema.String },
  success: Schema.String
})

const Deploy = Flow.make("e2e/secret/deploy", {
  payload: { apiKey: Schema.String, endpoint: Schema.String },
  success: Schema.String,
  body: (payload) => Use.call(payload)
})

const registration = Interpreter.layer(Deploy).pipe(
  Layer.provideMerge(
    Use.toLayer(({ apiKey, endpoint }) =>
      // The action logs the way a careless integration would, and returns a
      // string with the credential inside it. The second line logs a real
      // `Headers`: a brand-checked host object keeps its state in internal
      // slots, and a redacting logger that rebuilt it on its prototype
      // produced an impostor whose rendering threw from inside the logger and
      // killed the run, so this line proves the log survives as well as hides.
      Effect.logInfo(`calling ${endpoint} with Bearer ${apiKey}`).pipe(
        Effect.andThen(Effect.logInfo("request headers", new Headers({ authorization: `Bearer ${apiKey}` }))),
        // The third line carries the credential in a log span rather than in
        // the message. Effect sanitizes a span label before it is rendered,
        // folding `token=` into `token_`, so a rule anchored on a word
        // boundary never fired and the label printed the key in full.
        Effect.andThen(
          Effect.logInfo("deploy finished").pipe(Effect.withLogSpan(`fetch token=${apiKey}`))
        ),
        // The fourth line logs a cause carrying a host error. An aborted fetch
        // fails with a `DOMException`, whose `name` lives in an internal slot,
        // so a redacted copy built on its prototype is an impostor that throws
        // from inside `Cause.pretty` and kills the run the line describes.
        Effect.andThen(
          Effect.suspend(() => {
            const controller = new AbortController()
            controller.abort()
            return Effect.fail(controller.signal.reason).pipe(
              Effect.catchCause((cause) => Effect.logError(`cleanup after Bearer ${apiKey}`, cause))
            )
          })
        ),
        Effect.as(`deployed ${endpoint} token=${apiKey}`)
      )
    )
  ),
  Layer.provideMerge(Action.layerImplementations)
)

const exit = await Effect.runPromise(
  Deploy.execute({ apiKey: secret, endpoint: "https://example.test/deploy" }, { executionId }).pipe(
    Effect.provide(
      NodeRuntime.layerHost({ filename, owner: { hostId: "secret-host" }, signals: [] }, registration)
    ),
    Effect.scoped,
    Effect.exit
  ) as Effect.Effect<Exit.Exit<string, unknown>>
)

process.stdout.write(Exit.isSuccess(exit) ? "RESULT=ok\n" : "RESULT=failed\n")
process.exit(Exit.isSuccess(exit) ? 0 : 1)

/**
 * Reads the action calls one target plans.
 *
 * A rule's argv lives in its `implementation`, which is the Flow body. Nothing
 * runs here: the body is evaluated against the target's own validated attrs
 * and the resulting plan AST is walked, so an argv assertion is about the plan
 * a declaration produces rather than about spawning anything.
 */
import * as Node from "@smthrs/plan/Node"
import * as Target from "../src/Target.ts"

/** One planned action call: which action, and the payload it carries. */
export interface PlannedCall {
  readonly action: string
  readonly payload: Record<string, unknown>
}

const walk = (ast: Node.Ast, calls: Array<PlannedCall>): void => {
  switch (ast._tag) {
    case "ActionCall": {
      calls.push({ action: ast.action, payload: ast.payload as Record<string, unknown> })
      return
    }
    case "All": {
      for (const nested of Object.values(ast.nodes)) walk(nested, calls)
      return
    }
    case "Map": {
      walk(ast.first, calls)
      return
    }
    case "AndThen": {
      walk(ast.first, calls)
      // The continuation is only reachable through the side table the plan
      // package keeps for the interpreter; evaluating it against a placeholder
      // is what graph building itself does.
      const build = Node.continuation(ast)
      if (build !== undefined) {
        const next = build(Node.plannedReference("test") as never)
        if (Node.isNode(next)) walk(next.ast, calls)
      }
      return
    }
    case "Branch": {
      walk(ast.subject, calls)
      return
    }
    case "Catch": {
      walk(ast.first, calls)
      return
    }
    default:
  }
}

/** Every action call one target's plan records, in order. */
export const plannedCalls = (target: Target.AnyTarget): ReadonlyArray<PlannedCall> => {
  const metadata = Target.metadata(target)
  const body = (target as unknown as { readonly body: (attrs: unknown) => Node.Any }).body
  const calls: Array<PlannedCall> = []
  walk(body(metadata.attrs).ast, calls)
  return calls
}

/** The argv of the first exec-shaped call one target plans. */
export const plannedArgv = (target: Target.AnyTarget): ReadonlyArray<string> => {
  const call = plannedCalls(target).find((entry) => Array.isArray(entry.payload["argv"]))
  if (call === undefined) throw new Error(`${Target.metadata(target).target} plans no exec call`)
  return call.payload["argv"] as ReadonlyArray<string>
}

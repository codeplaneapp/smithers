import { z } from "zod"
import type { GraphNode, TargetGraphResponse } from "./TargetGraph"
import { splitLabel } from "./LocalApp"

/*
 * The CLI envelope → contract mapping, shared so the local backend
 * (`apps/ui/src/bun`) and the UI's dev fixture stream read the real CLI's
 * `--format json` answers identically. The graph envelope carries the text
 * rendering (`graph`) beside the structured rows (`targets`, `edges`); the
 * structured rows are the authority. The plan envelope (`<label> --plan
 * --format json`) merges per-node plan facts (rule, mode, key, cacheable,
 * argv, refusal) onto the nodes it names. Fixtures captured from the real
 * CLI on the force workspace live in `apps/shared/fixtures/force/`.
 */

export const CliGraphEnvelopeSchema = z.object({
  pattern: z.string(),
  format: z.string(),
  /** The text rendering (`label\n  -kind-> dep` lines); the structured rows below are the authority. */
  graph: z.string(),
  roots: z.array(z.string()),
  targets: z.array(z.object({ label: z.string(), target: z.string() })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.enum(["data", "gates", "services", "deps"]) })),
  warnings: z.array(z.string())
})
export type CliGraphEnvelope = z.infer<typeof CliGraphEnvelopeSchema>

export const CliPlanEnvelopeSchema = z.object({
  verb: z.string(),
  pattern: z.string(),
  roots: z.array(z.string()),
  targets: z.array(
    z.object({
      label: z.string(),
      rule: z.string(),
      mode: z.enum(["execute", "check", "write"]).optional(),
      key: z.string().optional(),
      cacheable: z.boolean().optional(),
      dependencies: z.array(z.string()).default([]),
      argv: z.array(z.string()).optional(),
      refusal: z.string().optional(),
      sandbox: z.string().optional(),
      outDirs: z.array(z.string()).optional(),
      outFiles: z.array(z.string()).optional()
    })
  )
})
export type CliPlanEnvelope = z.infer<typeof CliPlanEnvelopeSchema>

/** A private (unlabeled) helper node reads `__private_` (or another `__` prefix) in its name. */
export const isPrivateLabel = (label: string): boolean => splitLabel(label).name.startsWith("__")

/**
 * The CLI's graph envelope as the contract's `TargetGraphResponse`: one node
 * per target row (rule from the loader's `target` field), the edges as
 * classified, private helpers flagged. `generatedAt`/`durationMs` describe
 * THIS load, so the caller stamps them.
 */
export const targetGraphFromCli = (
  envelope: CliGraphEnvelope,
  options: { readonly repoId: string; readonly generatedAt?: string; readonly durationMs?: number }
): TargetGraphResponse => {
  const nodes: Array<GraphNode> = envelope.targets.map((target) => ({
    label: target.label,
    package: splitLabel(target.label).package,
    name: splitLabel(target.label).name,
    rule: target.target,
    kinds: [],
    private: isPrivateLabel(target.label)
  }))
  return {
    repoId: options.repoId,
    nodes,
    edges: envelope.edges,
    warnings: envelope.warnings,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    durationMs: options.durationMs ?? 0
  }
}

/**
 * Merge a `--plan --format json` envelope onto graph nodes: the plan's rule,
 * mode, key, cacheability, argv, sandbox, outputs, and refusal land on the
 * node it names; nodes the plan never mentions keep their loader row.
 */
export const mergePlanFacts = (
  graph: TargetGraphResponse,
  plan: CliPlanEnvelope
): TargetGraphResponse => {
  const facts = new Map(plan.targets.map((target) => [target.label, target]))
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const fact = facts.get(node.label)
      if (fact === undefined) return node
      return {
        ...node,
        rule: fact.rule,
        plan: {
          ...(fact.mode === undefined ? {} : { mode: fact.mode }),
          ...(fact.cacheable === undefined ? {} : { cacheable: fact.cacheable }),
          ...(fact.key === undefined ? {} : { key: fact.key }),
          ...(fact.refusal === undefined ? {} : { refusal: fact.refusal }),
          ...(fact.argv === undefined ? {} : { argv: fact.argv }),
          ...(fact.sandbox === undefined ? {} : { sandbox: fact.sandbox }),
          ...(fact.outDirs === undefined ? {} : { outDirs: fact.outDirs }),
          ...(fact.outFiles === undefined ? {} : { outFiles: fact.outFiles })
        }
      }
    })
  }
}

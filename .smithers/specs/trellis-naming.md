# Trellis naming

## Recommendation

**Trellis** is Smithers' bounded recursive orchestration capability.

**Tagline:** Let the work grow. Keep it bounded.

A trellis supports adaptive branching without prescribing a fixed route or
allowing uncontrolled spread. That maps directly to recursive author turns,
evidence-driven continuations, immutable accepted fragments, and hard authority,
fuel, depth, and concurrency limits.

## Product language

| Surface | Name |
| --- | --- |
| Workflow | `trellis` |
| Exported component | `Trellis` |
| UI | Smithers Trellis |
| Docs | Trellis: Bounded Recursive Orchestration |
| Internal protocol/module | delegation v2 / `delegation-v2` |

Use the metaphor sparingly:

- **Trellis** — the complete bounded orchestration.
- **Tend** — an author continuation inspecting evidence and choosing the next
  smallest action.
- **Shoot** — one accepted append-only subworkflow fragment.
- **Leaf** — one bounded worker task.
- **Harvest** — declared output fan-in or the final evidence package.
- **Bounds** — runtime authority, fuel, depth, concurrency, and budget policy.

Keep `agent`, `sequence`, and `parallel` as protocol terms. User-facing metaphor
must not obscure runtime semantics.

## Alternatives considered

| Candidate | Strength | Limitation |
| --- | --- | --- |
| Canopy | Friendly nested-topology image | Weak as a verb; says less about bounds |
| Braid | Strong noun/verb; excellent fan-in image | Says less about recursive growth |
| Banyan | Strong recursive-growth metaphor | Poor verb usability |
| Honeycomb | Bounded cells forming one whole | Weaker evidence/continuation metaphor |
| Sprout | Smallest-first growth | Feels less orchestration-grade |

The Sol naming panel found no exact `Trellis`, `Canopy`, or `Braid` collision in
the inspected repository. No trademark or domain-availability research was
performed, so this is a product-language recommendation rather than an external
availability claim.

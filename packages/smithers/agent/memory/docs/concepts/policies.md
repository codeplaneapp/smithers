---
title: "Memory policies"
description: "The memory policy a flow tree inherits: four fields, attached as an annotation, read back as defaults and two refusals."
sidebar:
  order: 3
---

A delegated plan generates work its author never named, so the memory settings that work runs under cannot be arguments threaded through every call. They are attached to the flow instead, as one annotation every flow in the tree inherits.

## The four fields

`WithMemory.Policy` has four fields:

| Field       | Values                     | Meaning                                       |
| ----------- | -------------------------- | --------------------------------------------- |
| `namespace` | a `Namespace`              | where memory this tree reads and writes lives |
| `recall`    | `"auto"`, `"none"`         | whether recall runs at all                    |
| `maxTokens` | integer                    | the byte budget recall answers within         |
| `retain`    | `"on-complete"`, `"never"` | whether writes are kept                       |

## Attachment and inheritance

`WithMemory.withMemory(flow, policy)` returns a copy of `flow` carrying the policy, and gives the same policy to every flow that flow declares. The original is untouched, and every annotation the tree already carried comes across. A nested flow that already carries a policy is replaced by this one, so the tree runs under exactly one policy and the inherited answer is predictable. The policy is decoded and deeply frozen at that call, so an invalid policy throws a typed `MemoryError` at graph-build time rather than failing at a SQL constraint, and mutating the object afterwards changes nothing.

The annotation takes no part in flow identity. Applying a policy never changes the graph a flow plans, node for node, which is what makes it safe to attach after a flow is declared.

Only a flow whose collaborators are data, one declared with `flows: [...]` and no body, carries children a decorator can rewrite. A flow with a body reaches its collaborators by calling them, and those calls are graph nodes rather than a list, so `WithMemory.children` returns nothing for one. `WithMemory.references` is the wider view: it includes registry names the runtime has not resolved to a flow yet, which a policy carries through untouched.

## Defaults and refusals

The runtime bindings `Flows.runRecallFor` and `Flows.runRememberFor` read the policy back, and `Flows.handlersFor(flow)` is the pair a host binds. The policy supplies defaults and never overrides:

- `runRecallFor` fills in the policy bank when the caller names no banks, and the policy budget when the caller states no `maxTokens`. A caller that names its own keeps them.
- `runRememberFor` resolves an empty bank to the policy namespace.

Two policy values are refusals rather than defaults, and they win over what the caller asked for:

- `recall: "none"` returns no rows and never reaches the recall service.
- `retain: "never"` drops the write. The caller still receives the key it asked for, and nothing reaches the store.

For the binding mechanics, provenance, and the delegation case, see [Scope a flow tree to a namespace](../guides/scope-a-flow-tree.md).

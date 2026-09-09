# Mythical coding product contract

This page records intended product behavior from the user's release brief. It is a design contract, not a statement that these features are shipped or fully implemented.

## Memory and planning

Coding begins by gathering relevant memory through workflows, then clarifying or pushing back where the evidence warrants it. Memory includes a clean linear mythical history and a separate wiki. A logical product Change groups small atomic changes; planned file reads and writes help schedule parallel work.

Native JJ change identities should survive history rewriting. Validation receipts must separately pin the exact JJ commit revision they evaluated. The product should place a thin opinionated grouping over existing JJ capabilities instead of inventing another identity for every atomic change. Owning code and generated explanations are linked by build dependencies; human intent and future direction remain distinct from current behavior.

## Three builds and optimistic progress

First, build a disposable proof of concept quickly. Save it for feedback and hindsight, then throw away its implementation. Second, implement for real. Fast checks block immediately; slow suites and agent reviews run asynchronously while later work proceeds. A correction to earlier ownership rewrites the earlier change and rebases dependents, invalidating their relevant checks. Third, once validation has passed and the work is marked vibed, rebuild the clean final history and perform the delivery steps described below.

Parallel execution still projects one linear mythical history. The UI should make predicted Changes, atomic steps, file ownership and pending validation easy to inspect. Cheap turn explanations orient the person; recursive debugger-like detail exposes the underlying evidence.

## Vibed is a transition, not shipment

After validation, mark work vibed. That starts final cleanup of changes, notes and plans, and delivery to main according to the project's policy. Additional checks or a canary may run before shipping. Vibed, landed and shipped therefore remain different recorded states.

Implementation should feel like an opinionated composition of existing primitives: Effect services, durable flows, build targets, Plue's JJ infrastructure and the existing embedded UI. Runtime portability is required; a Node sidecar is not an acceptable workaround for a Bun compatibility defect.

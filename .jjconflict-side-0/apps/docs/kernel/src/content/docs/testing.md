---
title: "Testing"
description: "Capability kernel: effect tiers, monotone capability sets, grant store, and permission-decorating layers over the Host services"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/kernel/docs/testing.md"
---

The package-owned [`@smthrs/kernel` suite](/reference/api/) covers capability-set
intersection, bounded and immutable grant state, journal replay and envelope
limits, canonical filesystem resources and descriptor identity, command
snapshots, process containment and ledger recovery, HTTP method/origin and
redirect authorization, Jujutsu resources, browser-safe imports, and every
supported and refused host operation. Its public
`@smthrs/kernel/test/contract` matrix is also run by the Node, Bun, browser,
test, and unsupported host bundles, including observable process liveness and
multi-leg pipelines.

---
title: "Contract"
description: "Capability kernel: effect tiers, monotone capability sets, grant store, and permission-decorating layers over the Host services"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/kernel/docs/contract.md"
---

`@smthrs/kernel` owns the closed host boundary and decorates the same service
tags supplied by each platform adapter. Capability checks happen before a host
operation, and mutable inputs are snapshotted so the operation executed after
an attended grant is the operation that was authorized. Native filesystems use
a descriptor-relative executor; isolated browser and test volumes may attest
whole-volume isolation. Process, network, Jujutsu, and filesystem refusals keep
their structured permission error through the host service's fixed error
channel. See the [Kernel API contract](/reference/api/) for the exact resources,
stable error codes, limits, and public test subpaths.

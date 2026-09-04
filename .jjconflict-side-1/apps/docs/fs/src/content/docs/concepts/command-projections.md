---
title: "Command projections"
description: "How @smthrs/fs projects routes onto agent, CLI, HTTP, and MCP surfaces while the flow's own Effect schema stays authoritative."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/fs/docs/concepts/command-projections.md"
---

A command projection turns the immutable routes from
[metadata routing](/concepts/metadata-routing/) into a surface a caller can drive.
`@smthrs/fs` ships two projections over the same route trie: `Command` for an
agent speaking one command string at a time, and `Incur` for shells, HTTP
clients, and MCP tools. They share the route model, the resolution rules, the
schema pipeline, and the error taxonomy, so a flow behaves identically no
matter which surface invokes it.

## The FlowInvoker seam owns execution

Nothing in this package runs a flow. The harness owns the run loop,
permissions, and durability, so it installs a `FlowInvoker` service, and both
projections hand it a materialized invocation: the resolved route name, the
loaded flow, and the schema-decoded input, frozen. The invoker's answer is
then encoded through the flow's output schema before it crosses back.

This keeps the adapter's responsibilities narrow: resolve, load, decode,
invoke, encode. Everything about how a run actually happens stays behind the
seam, which is also what makes the surfaces testable without a runtime. For
the testing patterns, see [Test flow invocation](/guides/test-flow-invocation/).

## Schemas check twice, for two different readers

A flow's Effect input schema does two jobs, and the projection separates
them:

1. **Advertisement.** The schema's JSON Schema rendering is projected into
   CLI descriptors, so `--help`, `--llms`, `--schema`, the OpenAPI document,
   and the MCP tool list publish the input the flow actually accepts. Unions
   keep every branch, literal sets keep their exact values, and the
   projection refuses input that contradicts the advertised type before the
   flow runs, naming the failing field without echoing the offending value.
2. **Authority.** The same Effect schema then decodes the assembled input for
   real. JSON Schema cannot express refinements such as a non-empty string,
   so a value can pass the advertised shape and still fail the authoritative
   decoder, which reports `decode_failed`. Flag values are never coerced by
   shape: `""`, `null`, and `[]` are refused for a numeric field instead of
   becoming `0`.

Output gets the same treatment in one direction: whatever the invoker
returns is encoded through the flow's output schema, and a mismatch reports
`encode_failed`. A flow therefore cannot silently return a shape it did not
declare, no matter what the harness handed back.

## Laziness is the loading contract

Dispatching one command imports only that command's module. The first
discovery request (a `--help`, an OpenAPI fetch, an MCP tool listing) must
publish real schemas for every command, so it loads every command module
once and caches the projections. A caller that only ever dispatches keeps
paying for exactly one import.

A route that cannot be projected at all, for example one declaring an output
locator as its input, stays advertised because it stays dispatchable. Hiding
it would make the failure undiscoverable; calling it reports the `FsError`
that stopped the projection.

## The `self` segment keeps groups discoverable

Incur cannot represent a node that is both runnable and a command group, so a
route with children, such as `domains` beside `domains/list`, would
disappear from every discovery surface if it were mounted plainly. The
projection mounts it under the reserved child segment `self`: `domains self`
on the CLI and `/domains/self` over HTTP, visible in `--llms`, `--schema`,
the OpenAPI document, and the MCP tool list. The bare name still dispatches,
because a request naming it exactly needs no children. A child route
literally named `self` under such a group is refused with `duplicate_route`.

## Errors are one sanitized taxonomy

Every projection reports failure as the same fifteen-code `FsError`, with
the failing surface named in `method`. Raw arguments, input and output
values, schema issues, and implementation causes are never retained, so an
error can cross to an agent or an HTTP client without disclosing what the
caller sent. Only `unknown_command` softens into help output; every other
failure reaches the caller as its typed code on both the CLI and HTTP
surfaces. The [error codes table](/contract/#error-codes) lists the
codes, and [Troubleshooting](/troubleshooting/) maps each one to its
cause and fix.

## Where to go next

- [Expose flows to an agent](/guides/expose-flows-to-an-agent/): the `Command` surface in practice.
- [Serve flows over CLI, HTTP, and MCP](/guides/serve-over-cli-http-and-mcp/): the `Incur` projection in practice.
- [Filesystem routing contract](/contract/): the normative schema, snapshot, and error rules.

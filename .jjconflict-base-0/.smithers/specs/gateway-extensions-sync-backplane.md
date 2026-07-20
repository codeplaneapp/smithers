# Gateway Extensions + Sync Backplane

A declarative surface for letting Smithers custom UIs (and apps/smithers) subscribe to gateway data and extension-provided resources without each UI hand-rolling RPC plumbing, stale-update handling, or stream resume.

## Why

A custom workflow UI today writes the same boilerplate over and over:

- One RPC method per piece of data it needs (issues, tickets, agent registry, vendor objects).
- A `useEffect` that fires the RPC, sets state, holds a flag for in-flight, and tries to fence the response so a stale answer cannot stomp a fresh one.
- A `WebSocket` subscription with a hand-rolled `streamId`, reconnect loop, backoff, and replay cursor.

The plumbing isn't hard, but it's the same six bugs every time: stale response wins, subscription leak after unmount, reconnect storm on the gateway, payload of unbounded size, scope check forgotten, namespace clash with another extension.

Smithers already has the right primitives — typed RPC dispatch, scoped auth, bounded payloads, run-event streams with replay semantics. What's missing is the declarative seam that lets an extension say "expose these typed resources, actions, and streams" and a hooks SDK that subscribes to them with the stale guards already baked in.

## What ships

### Server side: `gateway.extend(namespace, definition)`

```ts
gateway.extend("github", {
  defaultScope: "run:read",
  resources: {
    issue: {
      scope: "run:read",
      handler: async ({ id }, ctx) => {
        return await fetchGithubIssue(id, { signal: ctx.signal });
      },
    },
  },
  actions: {
    closeIssue: {
      scope: "run:write",
      handler: async ({ id, reason }) => closeGithub(id, reason),
    },
  },
  streams: {
    comments: {
      scope: "run:read",
      subscribe: async ({ issueId }, ctx) => {
        const initialBatch = await listGithubComments(issueId);
        const unsubscribe = onCommentEvent(issueId, (comment) => ctx.send(comment));
        return { initial: initialBatch, cleanup: unsubscribe };
      },
    },
  },
});
```

Wire format: `ext.<namespace>.<key>` for resources/actions (HTTP or WS) and `ext.stream.<namespace>.<key>` for streams (WS only). The dotted prefix keeps the built-in RPC dispatcher untouched and gives the gateway a cheap byte-prefix check for routing.

### Client SDK additions

- `client.extensionRpc(namespace, key, params, { signal })` for resources and actions.
- `client.streamExtension(namespace, key, params, { signal })` for streams — an async iterable that yields the initial replay payload first, then live frames filtered by the allocated `streamId`.

### React hooks

- `useGatewayExtensionResource(namespace, key, params, { enabled?, deps? })` — `{ data, error, loading, refetch }` with generation-counter stale guard. Re-rendering with new params cancels the in-flight call.
- `useGatewayExtensionAction(namespace, key)` — `{ call, pending, error, data }` with the same stale guard, so a fast double-click can't render the older result on top.
- `useGatewayExtensionStream(namespace, key, params, { maxFrames?, enabled?, backoff? })` — `{ frames, latest, error, streaming }`, ring-buffered to `maxFrames` (default 1000), reconnect with exponential backoff + jitter on drop, abort on unmount.

## Corner cases (and how this design handles them)

| Corner case | Handling |
|---|---|
| **Auth scopes** | Each resource/action/stream takes an optional `scope`; namespace `defaultScope` covers the rest. Gateway re-checks the scope at the dispatch layer in addition to the built-in `hasScope` pipeline, so a refactor that bypasses the connection-level check still can't elevate an extension. |
| **Namespace collisions** | `register(namespace, …)` throws if the namespace is already taken. A duplicate key across resource+action *within* one namespace also throws. Hot-reload requires explicit teardown — silently overwriting another extension's surface is the kind of bug that would only surface in production. |
| **Stream reconnect / resume** | The server allocates a `streamId` and stamps every frame with it. On client reconnect the client re-subscribes with the same params; the extension's `subscribe()` decides whether to honor a caller-supplied cursor (e.g. `afterSeq`) — clients can't fake durability the server doesn't provide. The React hook re-fences each subscription with a generation counter so late frames from the prior connection are dropped. |
| **Slow consumer / backpressure** | The existing gateway per-connection outbound queue applies. If a UI falls behind, the gateway disconnects with `BackpressureDisconnect`; the hook's reconnect loop picks it up. Extensions don't get to bypass backpressure. |
| **Large payload bounds** | `EXTENSION_PAYLOAD_MAX_BYTES = 4 MiB` is enforced for both single resource/action responses and every individual stream frame. Oversized resource responses return `PayloadTooLarge`; oversized stream frames emit an `ext.stream.error` event without breaking the subscription so other extensions on the same connection keep flowing. |
| **Extension errors** | Handler throws are normalized to one wire envelope. `SmithersError`-shaped throws keep their code; everything else surfaces as `EXTENSION_HANDLER_ERROR` with the message text (no stack — leaking handler internals to the wire would be a regression). |
| **Stale response guards** | The React hooks use a per-mount generation counter. A new render that changes params bumps the counter, so a still-pending earlier promise can't overwrite the latest state. Stream subscriptions fence frames by `streamId` and abort on unmount. |
| **Connection teardown** | The gateway socket-cleanup path now also calls `cleanupExtensionSubscriptions(connection)`, which aborts each per-subscription `AbortController` and runs the extension-supplied `cleanup()` callback. Hung cleanup callbacks run detached so they cannot block the connection close. |

## ElectricSQL Shapes as an optional read-source adapter

If an extension wants to back its `resources` and `streams` with a [Postgres-derived shape](https://electric-sql.com/docs/api/clients/typescript#shape) (e.g. `useShape` semantics on the server, surfaced to the gateway), that's fine — but only on the **read** side. Writes always flow through `actions`, not shapes, so the gateway's scope/audit/backpressure pipeline stays the system of record. The extension surface deliberately doesn't ship a built-in shape adapter; the registry is just a hook point, so an extension author can wire `electric-sql` inside `subscribe()` and call `ctx.send(row)` for each shape delta.

## Compatibility with `gateway.register(workflowKey, workflow)`

Untouched. Extension registration is additive — `extensions` is a separate `Map` on the `Gateway` instance, dispatch only triggers when the method name starts with `ext.`, and the existing workflow-UI mount logic (`getUiMounts`, custom UI assets) is unmodified. A workflow can both register its own UI (`register(key, workflow, { ui })`) and have the host extend the gateway with additional namespaces (`extend("github", …)`) — both surfaces ship on the same connection.

# @smithers-orchestrator/herdr - src

Socket client for [herdr](https://herdr.dev), the terminal workspace manager
Smithers mirrors runs into as an optional presentation & steering plane. This
package speaks herdr's newline-delimited-JSON unix-socket control API
(herdr 0.7.3, protocol 16) with zero runtime dependencies (node builtins only).

Herdr is optional and degradable: nothing here is on the engine hot path, and
every interaction is meant to be fire-and-forget. Prefer `tryCall()` for
steering pushes so a broken or absent herdr never affects a run.

## Exports

- `createHerdrClient(options?)` - build a client bound to a resolved socket.
- `createHerdrRunSurface(options?)` - mirror one Smithers run into a herdr
  workspace (one pane per agent node); soft/degradable, with a per-pane
  monotonic `seq`, a consecutive-timeout circuit breaker, and a bounded
  `close()` drain.
- `launchHijackPane(client, spec, ctx)` - open an interactive hijack pane in a
  herdr workspace; soft-fails to `undefined`.
- `HERDR_SURFACE_EVENT_TYPES` - the frozen set of Smithers event types the run
  surface's `onEvent` maps to a pane action; the single source of truth for
  pre-filtering an event stream before feeding the surface.
- `shortRunId(runId)` - first 8 chars of a run id, DISPLAY-ONLY (never an
  identity key - the surface uses the full run id everywhere).
- `HERDR_PROTOCOL` - the wire protocol version (`16`) this client targets.
- `HerdrError` - error thrown by `call()` on failure.
- `resolveSocketPath(opts?, env?)` / `sessionSocketPath(name, env?)` - socket
  path resolution helpers.
- `normalizeHerdrEventName(name)` - snake_case -> dotted event-name normalizer.

## Connection model

herdr serves **one request per connection** (it responds to the first request,
then closes), except `events.subscribe`, whose connection stays open and
streams events. The client follows that model exactly:

- `call(method, params)` opens a socket, writes one `{id, method, params}`
  line, reads the one response frame, and closes. It rejects with a `HerdrError`
  on an error frame (including protocol-level empty-id error frames), a per-call
  timeout (default 5s), an absent socket, or a connection that closes before
  responding. There is no id multiplexing.
- `tryCall(method, params)` wraps `call` and soft-fails: it logs a warning and
  resolves `undefined` instead of throwing.
- `subscribe(subscriptions, onEvent)` holds a dedicated long-lived connection.
  The first frame is the `subscription_started` ack (not delivered); subsequent
  event frames are delivered to `onEvent`. It auto-reconnects with capped
  exponential backoff (250ms -> 5s) and resubscribes on reconnect - herdr
  replays current state on subscribe, so resubscription is safe. `handle.close()`
  stops reconnection and destroys the socket (idempotent). Caveat: the reconnect
  timer is `unref`'d, so a process kept alive ONLY by a subscription can exit
  during a backoff wait - hold another ref if the subscription must keep the
  process running.
- `ping()` is soft (returns `undefined` when unreachable) and logs a warning if
  the server reports a protocol other than `HERDR_PROTOCOL`.

Event names arrive snake_case (`workspace_created`) and differ from the dotted
subscription `type` strings (`workspace.created`); one event
(`pane.agent_status_changed`) already arrives dotted. Each delivered
`HerdrEvent` carries the raw `event` name plus a normalized dotted `type` so
consumers can match tolerantly.

## Socket path resolution

Highest precedence first: explicit `options.socketPath` -> `options.session`
(named session) -> `HERDR_SOCKET_PATH` env -> `HERDR_SESSION` env (named
session) -> the default session socket (`<config>/herdr/herdr.sock`, where
`<config>` is `$XDG_CONFIG_HOME` or `~/.config`).

## Usage

```js
import { createHerdrClient } from "@smithers-orchestrator/herdr";

const herdr = createHerdrClient({ session: "my-session" });

const pong = await herdr.ping(); // undefined if herdr is not running
const ws = await herdr.call("workspace.create", { label: "my run", focus: false });

const handle = herdr.subscribe([{ type: "workspace.created" }], (event) => {
	console.log(event.type, event.data);
});
// ... later
handle.close();

// steering pushes should be soft so herdr can never break a run:
await herdr.tryCall("workspace.close", { workspace_id: ws.workspace.workspace_id });
```

`src/index.d.ts` is the committed public type surface - keep it in sync with the
exports and the JSDoc-referenced `HerdrProtocol.ts` / `HerdrClientOptions.ts`.

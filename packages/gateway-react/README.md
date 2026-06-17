# @smithers-orchestrator/gateway-react

React bindings for the Smithers Gateway. This package is the React layer used by
`smithers ui` workflow UIs: it provides the provider, root bootstrap helper, and
hooks that let a custom workflow UI read runs, events, approvals, node output,
extension resources, and gateway actions from the active Gateway.

Most workflow UIs should import it through the public Smithers package path:

```tsx
/** @jsxImportSource react */
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
} from "smithers-orchestrator/gateway-react";

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function App() {
  const runId = runIdFromUrl();
  const run = useGatewayRun(runId);
  const events = useGatewayRunEvents(runId, { maxEvents: 100 });
  const approvals = useGatewayApprovals(runId ? { filter: { runId } } : {});
  const output = useGatewayNodeOutput({ runId, nodeId: "ship" });
  const { cancelRun } = useGatewayActions();

  return (
    <main>
      <h1>{String(run.data?.workflowKey ?? "Workflow")}</h1>
      <p>Status: {String(run.data?.status ?? "loading")}</p>
      <p>Events: {events.events.length}</p>
      <p>Approvals: {approvals.data?.length ?? 0}</p>
      <pre>{JSON.stringify(output.data, null, 2)}</pre>
      <button onClick={() => runId && cancelRun({ runId })} disabled={!runId}>
        Cancel
      </button>
    </main>
  );
}

createGatewayReactRoot(<App />);
```

## Root helpers

- `createGatewayReactRoot(element, options)` mounts a React UI into `#root`,
  creates a `SmithersGatewayClient`, and installs both gateway contexts. This is
  the default bootstrap for `.smithers/ui/*.tsx` bundles served by `smithers ui`.
- `SmithersGatewayProvider` provides an existing or newly-created gateway client
  to hooks that make direct RPC calls.
- `SyncProvider` provides the live collection registry used by the sync-backed
  hooks. `createGatewayReactRoot` wires this automatically.

## Hooks

- `useGatewayRuns`, `useGatewayRun`, `useGatewayRunEvents`, and
  `useGatewayRunTree` read live run state.
- `useGatewayApprovals`, `useGatewayActions`, and `useGatewayNodeOutput` cover
  the common operator controls for workflow UIs.
- `useGatewayExtensionResource`, `useGatewayExtensionAction`, and
  `useGatewayExtensionStream` bind custom gateway extensions into React.
- `useGatewayRpc` is the lower-level escape hatch for gateway RPC methods.
- `useGatewayQuery`, `useGatewayMutation`, `useSyncQuery`,
  `useSyncMutation`, and `useSyncSubscription` expose the declarative sync
  client when a UI needs collection-level control.

## Manual provider setup

Use the providers directly when embedding the hooks outside the `smithers ui`
bootstrap:

```tsx
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  SmithersGatewayProvider,
  SyncProvider,
  createGatewayCollections,
} from "@smithers-orchestrator/gateway-react";
import {
  SmithersGatewayClient,
  createSmithersGatewayTransport,
} from "@smithers-orchestrator/gateway-client";

const client = new SmithersGatewayClient({ baseUrl: "http://localhost:7331" });
const collections = createGatewayCollections({
  client: createSmithersGatewayTransport(client),
});

createRoot(document.getElementById("root")!).render(
  createElement(
    SmithersGatewayProvider,
    { client },
    createElement(SyncProvider, { client: collections }, createElement(App)),
  ),
);
```

See `docs/examples/workflow-ui-react.mdx` for a complete workflow UI example.

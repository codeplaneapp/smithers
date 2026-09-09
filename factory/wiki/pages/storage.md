# Journal and durable stores

The shared runtime composes the existing journal, run store, attempt store, cache store and engine state over an injected SQL client. Product coding work should reuse those execution records. It should not open an independent command ledger or recreate ownership and leases.

## A journal is structured execution evidence

Journal entries are ordered, typed records. Its durable lifecycle channel waits for persistence; its telemetry channel uses a bounded queue and can drop under pressure. An emission reports acceptance, duplication or dropping. Producer identity makes a retried emission distinguishable from new evidence.

The journal also supports checkpoints and compaction. Append-only emission is not a promise that all historical rows remain forever. UI history readers must respect the retained record, not assume missing data can be reconstructed from today's objects.

## Share the injected database

`Runtime.storage` composes migrations and stores without choosing a SQL driver. The executable provides the SQL layer and the platform services. `DurableWriter` supplies the shared serialized transaction policy used by durable writes.

The existing `NodeRuntime` and `BunRuntime` facades select the native database adapter. The common storage function's filename locates artifact storage; the injected SQL client chooses the actual database connection. If an application already owns the SQL instance, compose at this seam.

## Separate facts with different owners

The run store summarizes run lifecycle. The journal records execution evidence. Action outputs carry typed results for downstream work. A product projection may be useful for querying these facts, but it should point to the original run and revision rather than pretend to be a second source of execution truth.

Wiki source snapshots are artifacts of a flow, not another scheduler. Collaborative human-authored pages belong to the wiki's persistence boundary, separately from the generation artifact and the flow's own replay record.

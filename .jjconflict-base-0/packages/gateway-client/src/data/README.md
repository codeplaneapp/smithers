# data/

The workspace data layer. `createSmithersDataClient` wraps the REST
`/v1/api/*` surface plus the SSE change stream (connection-status tracking,
jittered-backoff reconnection, `waitForSeq` read-your-writes for mutations).
`createSmithersCollections` builds TanStack DB collections on top of it for
both `WorkspaceMode`s.

Mode split: local mode uses query collections
(`smithersLocalCollectionOptions`) invalidated by SSE change events;
multiplayer mode uses ElectricSQL shape collections. The Electric loader lives
ONLY in `smithersElectricCollectionOptions.ts` behind a dynamic import —
`tests/data/local-import-boundary.test.ts` source-scans
`createSmithersCollections.ts` to prove local bundles never touch Electric
packages, so never add a static Electric import there.

Row mapping: `mapSmithersElectricRow` must stay in shape-parity with the
gateway REST serializers (`tests/data/electric-row-parity.test.ts`);
`normalizeGatewayRunEventRow` tolerates camel/snake casing and stringified
payloads.

Keys: `smithersCollectionKeys` (canonical query keys), `gatewayKeys` (legacy
aliases for the React hooks), and `smithersApiInvalidationPrefixes` (SSE
collection name → key prefixes) must stay aligned when adding a collection.

Every file is a public npm subpath via the package's `./*` export.

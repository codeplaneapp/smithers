# Honor document and ticket filters and hide tombstones

GitHub: https://github.com/smithersai/smithers/issues/1015

Parent: smithers/gh-790-fix-gateway-client-medium-multiplayer-coll-0w5zwp2.md

Context: Multiplayer docs only filter kind, while tickets force omitted kind to ticket and can expose deleted _smithers_docs rows. Implement parity with listDocs and listTickets, including kind, includeDeleted, updatedAfterMs, limit, omitted ticket kind, explicit ticket kind, and live-row semantics. Acceptance criteria: docs parity is verified for all documented filters; tickets without kind include every live document kind; explicit kind restricts results; deleted rows never appear in listTickets; tombstone behavior is covered by regression tests.


> Closed by ticket-fleet sync: Implemented and tested. createSmithersCollections.ts applies docs kind/includeDeleted/updatedAfterMs filters, routes limit requests through RPC, and enforces live-row ticket predicates with unrestricted omitted kind. gateway.js forwards docs filters and listTickets uses adapter.listDocs(kind ?? null), whose default excludes tombstones. collectionsDocsTicketsParity.test.ts covers real-pglite docs parity, ticket kind behavior, limits, and tombstone regression. Relevant tests passed: gateway-client 4/4, server RPC coverage 3/3, DB doc tests 70/70.

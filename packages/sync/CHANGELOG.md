# @smthrs/sync

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added workspace authentication: the `SyncAuth` RPC middleware and its
  header-verifying implementation, the `WorkspaceShare` capability authority
  over a `Redacted` keyring with `kid` rotation, and the per-request
  `SyncPrincipal` whose default is anonymous.
- Added compaction recovery: `SyncProtocol.Resync`, the `compacted` error code
  and `SyncError.resync`, and the client-side resync that moves a run's cursor
  to the checkpoint and restarts instead of dying.
- Added `SubscribeOptions.onResync`, the seam a consumer restores checkpoint
  state through. It runs before the cursor moves and must succeed, so a
  follower that cannot fill the hole fails rather than skipping it silently.
- Added `SubscribeOptions.apply`, which advances a cursor only after the
  consumer has applied the entry, so `RunCursor` can mean what its schema says.
- Added the bounded workspace fan-out: `SyncServer.Options.concurrency` and
  `tailIntervalMs`, plus `RunCatalog.makePolling` for the durable run set a
  workspace follower learns from.
- Added request limits `SyncProtocol.maxReadLimit` and `maxSubscribeCredit`,
  the branch ledger bound `BranchCommands.defaultLedgerCapacity`, and the
  roster bound `BranchPresence.defaultMaxParticipants`.
- Added golden wire vectors: the encoded form of every frame variant, a read
  response, a command receipt, the capability header, and both authorities'
  signatures are frozen as literals, so a renamed field or a changed signing
  encoding fails a test rather than a deployed follower.

### Changed

- **Breaking.** `SyncError.cause` is a bounded string rather than
  `Schema.Unknown`. It is the declared error schema of every RPC, so it now
  carries a rendering instead of the host object that failed; a journal
  failure crosses as its stable journal code and never as the driver's own
  message.
- **Breaking.** `BranchShare.makeHmac` and `layerHmac` take a `Redacted`
  secret, and the branch scheme signs a scheme label, so a branch signature can
  no longer be replayed as a workspace signature under a shared secret.
  Outstanding branch capabilities do not verify under this release.
- **Breaking.** A subscription's `credit` must be between 1 and
  `maxSubscribeCredit`, and a read's `limit` at most `maxReadLimit`. A cursor
  set that names one run twice is refused with `invalid_request`.
- **Breaking.** `BranchRpcs`'s submit, announce, leave, and roster payloads are
  the service schemas rather than copies of them, so `displayName: ""` is a
  typed wire refusal instead of a defect raised inside the presence service.
- **Breaking.** `makeLiveWith`, `layerWith`, and `BranchPresence.layer` fail
  with `invalid_request` when an option is not a positive safe integer.
  `BranchPresence.Service` gained `leaseMs`.
- An open subscription ends with `unauthorized` when the capability that
  authorized it expires. Authorization was one-shot at open, so a share-link
  holder could read past its own expiry by staying connected.
- Catch-up paging defers its cursor snapshot, so every page past the first asks
  from where the previous one ended instead of repeating the previous request.
- Catch-up pages are validated the way live frames already were: scope,
  per-run ordering, progress past the requested cursor, and cursor uniqueness,
  refused as `protocol_violation` before any cursor moves.
- A workspace subscription reconciles its covered run set against
  `RunCatalog.list` every round, so a run the catalog gains becomes visible
  without an announcement and a run it stops naming is no longer queried.
- A workspace tail reads one bounded page per run per round, so a permanently
  busy run wakes the next round instead of holding its fan-out slot.
- The server deduplicates `RunCatalog.list` at the seam. A host catalog that
  named one run twice had it read twice from the same served position, so a
  read page carried its entries twice and a subscription opened two concurrent
  tails of it emitting identical frames.
- `BranchCommands` keys its ledger and permit per branch, and `BranchPresence`
  keys its roster per branch, so ids sharing a delimiter no longer collide and
  one branch's replay no longer stalls another's writes.
- `BranchCommands.replay` ends its walk on an empty page, matching the guard
  the workspace tail already carried.
- An admission conflict on a command whose receipt the bounded ledger has
  already evicted reads the branch's durable history for it, so it is reported
  as the duplicate it is instead of as a journal contradicting its own conflict
  report.
- `Branch.MintShare` refuses a parent capability that expired mid-request
  rather than minting a link that can never authorize.
- `BranchShare` and `WorkspaceShare` verify from a snapshot taken at entry, so
  claims cannot widen while Web Crypto is in flight.
- Share claims are refused with `invalid_request` when they do not survive
  UTF-8, and length prefixes count UTF-8 bytes rather than UTF-16 units.
- `encodedByteLength` is total: a value with no JSON text costs the bytes
  `null` occupies, and a value JSON refuses measures as infinite so it trips
  every ceiling rather than throwing.
- `branchOfRunId` returns `null` for the bare branch prefix instead of
  branding an empty string as a `BranchId`.
- `RunCatalog.layerStatic` answers `list` with a fresh array, matching the
  other implementations.
- `BranchShare.makeNoop` and `WorkspaceShare.makeNoop` fail `mint` instead of
  dying, matching their declared type and the rest of the package.
- `SyncError.is` validates the code, the message, and the `resync` invariant
  rather than trusting a bare tag.
- `HeartbeatFrame` is documented as reserved: no server emits one, so a client
  must not wait for it.
- Documentation is package-owned and generated: `docs/pages/api/sync.md` and
  the protocol section of `docs/pages/concepts/sync.md` come from this
  package's JSDoc and `docs/`.

## [0.1.0] - 2026-08-05

### Added

- Added the workspace read-path sync protocol with its server, client, and
  run catalog.
- Added the shared branch protocol, presence, projection, commands, share, and
  RPCs, with authorization enforced on the server.

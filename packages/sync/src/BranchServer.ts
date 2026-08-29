/**
 * The server-side handlers of {@link BranchRpcs}: a thin, honest projection of
 * the branch services onto the wire.
 *
 * There is deliberately no authorization logic here. Every procedure forwards
 * to the service that owns its boundary — {@link BranchShare} for minting,
 * {@link BranchCommands} for admission, {@link BranchPresence} for the roster —
 * so an in-process caller and a remote caller face exactly the same rules.
 *
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import type * as Rpc from "effect/unstable/rpc/Rpc"
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import * as BranchCommands from "./BranchCommands.ts"
import * as BranchIds from "./BranchIds.ts"
import * as BranchPresence from "./BranchPresence.ts"
import type { BranchId } from "./BranchProtocol.ts"
import { BranchRpcs } from "./BranchRpcs.ts"
import * as BranchShare from "./BranchShare.ts"
import { SyncError } from "./SyncError.ts"
import * as SyncPrincipal from "./SyncPrincipal.ts"

/**
 * Provides the branch RPC handlers over the branch services.
 *
 * A roster watch emits the roster as of subscription, then re-lists on every
 * presence change for the branch. Expiry needs no timer of its own: every
 * live participant heartbeats its lease, each heartbeat is a change, and each
 * change re-lists — so a dead participant ages out of every watch within one
 * heartbeat of the survivors.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHandlers: Layer.Layer<
  Rpc.ToHandler<RpcGroup.Rpcs<typeof BranchRpcs>>,
  never,
  | BranchShare.BranchShare
  | BranchPresence.BranchPresence
  | BranchCommands.BranchCommands
  | BranchIds.BranchIds
> = BranchRpcs.toLayer(
  Effect.gen(function*() {
    const share = yield* BranchShare.BranchShare
    const presence = yield* BranchPresence.BranchPresence
    const commands = yield* BranchCommands.BranchCommands
    const ids = yield* BranchIds.BranchIds

    return BranchRpcs.of({
      "Branch.CreateBranch": ({ ttlMs }) =>
        Effect.gen(function*() {
          const principal = yield* SyncPrincipal.SyncPrincipal
          if (!SyncPrincipal.isWorkspace(principal)) {
            return yield* new SyncError({
              code: "unauthorized",
              message: "Creating a branch requires an authenticated workspace principal"
            })
          }
          const capability = yield* share.mint({
            branchId: (yield* ids.fresh) as BranchId,
            capabilityId: yield* ids.fresh,
            access: "write",
            ttlMs
          })
          return { branchId: capability.claims.branchId, capability }
        }),
      "Branch.MintShare": ({ capability, access, ttlMs }) =>
        Effect.gen(function*() {
          const claims = yield* share.verify(capability, {
            branchId: capability.claims.branchId,
            access: "write"
          })
          const nowMs = yield* Clock.currentTimeMillis
          // A link never outlives the capability it was minted from.
          return yield* share.mint({
            branchId: claims.branchId,
            capabilityId: yield* ids.fresh,
            access,
            ttlMs: Math.min(ttlMs, Math.max(claims.expiresAtMs - nowMs, 0))
          })
        }),
      "Branch.Submit": (payload) => commands.submit(payload),
      "Branch.Announce": (payload) => presence.announce(payload),
      "Branch.Leave": (payload) => Effect.as(presence.leave(payload), null),
      "Branch.Roster": (payload) => presence.list(payload),
      "Branch.WatchRoster": (payload) =>
        Stream.merge(
          Stream.fromEffect(presence.list(payload)),
          presence.changes.pipe(
            Stream.filter((branchId) => branchId === payload.branchId),
            Stream.mapEffect(() => presence.list(payload))
          )
        ).pipe(
          Stream.map((participants) => ({ participants }))
        )
    })
  })
)

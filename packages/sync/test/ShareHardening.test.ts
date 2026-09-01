/**
 * The signing boundary's adversarial cases: encodings that do not survive
 * UTF-8, domain separation between the two authorities, and claim sets mutated
 * while Web Crypto is in flight.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import type { JournalEvent } from "@smthrs/journal"
import { Effect, Exit, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { branchOfRunId, branchRunId, ShareCapability, ShareClaims } from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import { SyncError } from "../src/SyncError.ts"
import * as WorkspaceShare from "../src/WorkspaceShare.ts"

const secret = "shared-hardening-secret"
const branchId = "branch-hardening" as ShareClaims["branchId"]

const run = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provide(TestClock.layer()))

const branchAuthority = BranchShare.makeHmac({ secret: Redacted.make(secret) })

describe("share claim encoding", () => {
  // `TextEncoder` folds every unpaired surrogate to U+FFFD, so two claim sets
  // differing only in a lone surrogate sign to identical bytes and a length
  // prefix cannot separate them: both encode to the same three bytes. The
  // input is refused before it is signed.
  it.effect("refuses to sign or verify claims carrying an unpaired surrogate", () =>
    Effect.gen(function*() {
      const [mintFailure, verifyFailure] = yield* run(
        Effect.gen(function*() {
          const share = yield* branchAuthority
          const lone = "\uD800" as typeof branchId
          const minted = yield* Effect.flip(
            share.mint({ branchId: lone, capabilityId: "cap", access: "read", ttlMs: 60_000 })
          )
          const forged = new ShareCapability({
            claims: new ShareClaims({
              branchId: lone,
              capabilityId: "cap",
              access: "read",
              issuedAtMs: 0,
              expiresAtMs: 60_000
            }),
            signature: "00"
          })
          return [minted, yield* Effect.flip(share.verify(forged, { branchId: lone, access: "read" }))] as const
        })
      )

      expect(mintFailure.code).toBe("invalid_request")
      expect(verifyFailure.code).toBe("invalid_request")
    }))

  // A well-formed astral id round-trips through UTF-8 and is signed normally,
  // so the refusal above is about non-round-trippable input and not about
  // anything outside the basic multilingual plane.
  it.effect("mints and verifies an astral-plane branch id", () =>
    Effect.gen(function*() {
      const claims = yield* run(
        Effect.gen(function*() {
          const share = yield* branchAuthority
          const astral = "branch-\u{1F680}" as typeof branchId
          const capability = yield* share.mint({
            branchId: astral,
            capabilityId: "cap-\u{1F680}",
            access: "read",
            ttlMs: 60_000
          })
          return yield* share.verify(capability, { branchId: astral, access: "read" })
        })
      )

      expect(claims.branchId).toBe("branch-\u{1F680}")
      // The run-id mapping is reversible for the same id.
      expect(branchOfRunId(branchRunId(claims.branchId))).toBe("branch-\u{1F680}")
    }))

  // `flows/branch/` with nothing after it is a non-branch run, not a branch
  // with an empty id: `BranchId` is a branded NonEmptyString, and branding
  // `""` would hand `share.verify` a value the brand forbids.
  it("treats the bare branch prefix as a non-branch run", () => {
    expect(branchOfRunId("flows/branch/" as JournalEvent.RunId)).toBeNull()
    expect(branchOfRunId("flows/engine/run-1" as JournalEvent.RunId)).toBeNull()
    expect(branchOfRunId(branchRunId(branchId))).toBe(branchId)
  })
})

describe("share domain separation", () => {
  // Both authorities can be configured with one secret. Each leads its signed
  // encoding with its own scheme label, so neither's signature can be replayed
  // as the other's. Before, only the workspace side carried a label, which
  // protected exactly one direction.
  it.effect("refuses a workspace signature presented as a branch capability", () =>
    Effect.gen(function*() {
      const outcome = yield* run(
        Effect.gen(function*() {
          const branch = yield* branchAuthority
          const workspace = yield* WorkspaceShare.makeHmac({
            activeKid: "k1",
            keys: [{ kid: "k1", secret: Redacted.make(secret) }]
          })
          const workspaceCapability = yield* workspace.mint({
            capabilityId: branchId,
            access: "read",
            ttlMs: 60_000
          })
          const branchCapability = yield* branch.mint({
            branchId,
            capabilityId: "cap",
            access: "read",
            ttlMs: 60_000
          })
          const replayed = new ShareCapability({
            claims: new ShareClaims({
              branchId,
              capabilityId: "cap",
              access: "read",
              issuedAtMs: workspaceCapability.claims.issuedAtMs,
              expiresAtMs: workspaceCapability.claims.expiresAtMs
            }),
            signature: workspaceCapability.signature
          })
          return {
            branchSignature: branchCapability.signature,
            replayFailure: yield* Effect.flip(branch.verify(replayed, { branchId, access: "read" })),
            workspaceSignature: workspaceCapability.signature
          }
        })
      )

      expect(outcome.replayFailure.code).toBe("unauthorized")
      expect(outcome.branchSignature).not.toBe(outcome.workspaceSignature)
    }))
})

describe("share verification under concurrent mutation", () => {
  // `Schema.Class` instances are not frozen, and `verify` awaits Web Crypto
  // between signing the claims and authorizing them. Everything it authorizes
  // is read from a snapshot taken at entry, so a holder of the same decoded
  // instance cannot widen the grant mid-verification.
  it.effect("authorizes the claims it signed, not the claims as they are afterwards", () =>
    Effect.gen(function*() {
      const outcome = yield* run(
        Effect.gen(function*() {
          const share = yield* branchAuthority
          const capability = yield* share.mint({
            branchId,
            capabilityId: "cap",
            access: "read",
            ttlMs: 60_000
          })
          const verification = yield* Effect.forkChild(
            Effect.exit(share.verify(capability, { branchId, access: "write" })),
            { startImmediately: true }
          ) // The adversary holds the same decoded object while the HMAC is in
           // flight and widens it from read to write.
          ;(capability.claims as { access: string }).access = "write"
          return yield* Fiber.join(verification)
        })
      )

      expect(Exit.isFailure(outcome)).toBe(true)
    }))
})

describe("share authorities that are switched off", () => {
  // `mint` used to DIE where its own declared type promises a `SyncError`, and
  // `WorkspaceShare.layerNoop` is what the shipped CLI gateway wires: a
  // consumer handling `SyncError` there got a crash instead of a refusal.
  it.effect("refuses rather than dies when sharing is unavailable", () =>
    Effect.gen(function*() {
      const [branchMint, workspaceMint] = yield* run(
        Effect.gen(function*() {
          const branch = yield* BranchShare.BranchShare
          const workspace = yield* WorkspaceShare.WorkspaceShare
          return [
            yield* Effect.flip(branch.mint({ branchId, capabilityId: "c", access: "read", ttlMs: 1 })),
            yield* Effect.flip(workspace.mint({ capabilityId: "c", access: "read", ttlMs: 1 }))
          ] as const
        }).pipe(Effect.provide(Layer.mergeAll(BranchShare.layerNoop, WorkspaceShare.layerNoop)))
      )

      expect(SyncError.is(branchMint)).toBe(true)
      expect(branchMint.code).toBe("unauthorized")
      expect(SyncError.is(workspaceMint)).toBe(true)
      expect(workspaceMint.code).toBe("unauthorized")
    }))
})

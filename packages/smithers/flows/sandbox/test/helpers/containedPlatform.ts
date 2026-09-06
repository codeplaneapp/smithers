import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import { Effect, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export const rawPlatform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

const containment = (lifecycle?: ContainedSpawner.Lifecycle) =>
  ContainedSpawner.layer({ graceMs: 80, platform: process.platform }, lifecycle).pipe(
    Layer.provide(ProcessLedger.layerMemory({ hostId: "sandbox-tests", ownerPid: process.pid }))
  )

export const platform = Layer.provideMerge(
  ProcessReaper.layerSpawner({ graceMs: 80 }).pipe(
    Layer.provide(ProcessLedger.layerMemory({ hostId: "sandbox-tests", ownerPid: process.pid }))
  ),
  rawPlatform
)

export const contain = (
  spawner: ChildProcessSpawner["Service"],
  lifecycle?: ContainedSpawner.Lifecycle
) =>
  ChildProcessSpawner.pipe(
    Effect.provide(containment(lifecycle)),
    Effect.provideService(ChildProcessSpawner, spawner)
  )

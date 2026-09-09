/** Private deployment recipe. Existing native host, catalog, agents and JJ ports. */
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Executable from "@smthrs/registry/Executable"
import { HumanTask, Interpreter } from "@smthrs/flow"
import { Context, Effect, FileSystem, Layer } from "effect"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as NativeEquipment from "../../packages/smithers/src/internal/NativeEquipment.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { atomDelegate, atomFlows, atomOperations, EditAtom } from "./atoms.ts"
import { checkDelegate, checkLayers } from "./checks.ts"
import { NativeCoding, nativeActions, nativeLayer, type NativeOptions } from "./native.ts"
import { registration, RunPlan } from "./registration.ts"
import * as Snapshots from "./snapshots.ts"
import * as CodingFileSystem from "./filesystem.ts"
import { correctionLayers, SelectRepair } from "./correction.ts"
import { memoryLayer, type MemoryOptions } from "./planning-memory.ts"
import { DraftPlan, planningPolicy, PreparePlan, ReviewRequest } from "./planning.ts"
import { evidenceOnly } from "./planning-authority.ts"
import { requestRegistration, RunRequest } from "./request.ts"
import { sourceAdmission } from "./source-admission.ts"

/** Operator configuration, never accepted from a workflow or gateway request. */
export interface Options extends NativeOptions {
  readonly gatewayId: string
  readonly implementationModel: string
  readonly exporterPath?: string | undefined
  readonly checkEnvironment?: Readonly<Record<string, string>> | undefined
  /** Enables the private prompt route using this repository's owning memory/check configuration. */
  readonly planning?: Omit<MemoryOptions, "repositoryPath"> | undefined
  readonly planningModel?: string | undefined
}

const role = "coding/implement"
const configured = (options: Options) => {
  if (!/^[a-z0-9-]+:[^\s:]+$/.test(options.implementationModel)) {
    throw new Error("Set SMITHERS_CODING_IMPLEMENT_MODEL to an explicit provider:model for coding/implement")
  }
  if (options.planningModel !== undefined && !/^[a-z0-9-]+:[^\s:]+$/.test(options.planningModel)) {
    throw new Error("The planning model must be an explicit provider:model")
  }
  if (!/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.gatewayId)) {
    throw new Error("A configured coding host requires its owning SMITHERS_GATEWAY_ID")
  }
}

/** Resolves the role through the existing workspace/user credential route. */
export const roleResolver = (base: SeatResolver.Service, implementationModel: string, planningModel = implementationModel): SeatResolver.Service => SeatResolver.make({
  resolve: id => base.resolve(id === role ? implementationModel : id === "coding/plan" ? planningModel : id).pipe(
    Effect.map(seat => id === role || id === "coding/plan" ? Seat.make({ ...seat, id }) : seat)
  )
})

/** Both platform entries call this one recipe; no second executor or store. */
export const layer = (platform: NativeControl.Platform, options: Options, suppliedSeats?: SeatResolver.Service) => {
  configured(options)
  const native = NativeControl.make({ ...platform,
    jj: root => Snapshots.layerAt({ ...options, repositoryPath: root }),
    filesystem: (root, fs, spawner) => fs.realPath(root).pipe(
      Effect.map(canonicalRoot => CodingFileSystem.make({ ...options, repositoryPath: root }, fs, spawner, canonicalRoot)),
      Effect.orDie
    )
  }, environment => Layer.effect(SeatResolver.SeatResolver)(
    Effect.map(SeatResolver.SeatResolver, base => roleResolver(base, options.implementationModel, options.planningModel))
  ).pipe(Layer.provide(suppliedSeats === undefined ? NativeEquipment.layerSeatResolver(environment) : SeatResolver.layer(suppliedSeats))))
  return Layer.suspend(() => Layer.unwrap(Effect.gen(function*() {
    // Only scratch creation and cleanup receive the existing trusted host FS.
    // Check processes and all agent tools retain the native host's guards.
    const fs = yield* FileSystem.FileSystem
    const request = options.planning === undefined ? Layer.empty : Layer.mergeAll(
      memoryLayer({ ...options.planning, repositoryPath: options.repositoryPath }),
      planningPolicy, Interpreter.layer(PreparePlan), HumanTask.layer, correctionLayers, sourceAdmission, requestRegistration,
      evidenceOnly(Layer.mergeAll(ReviewRequest.layer, DraftPlan.layer, SelectRepair.layer))
    )
    const leaves = Layer.mergeAll(atomFlows, atomOperations, EditAtom.layer, nativeActions, request,
      checkLayers({ repositoryPath: options.repositoryPath, fs,
        exporterPath: options.exporterPath, environment: options.checkEnvironment }))
      .pipe(Layer.provideMerge(nativeLayer(options)))
    // Loading verified declaration bytes reserves a sibling temporary module.
    // This is host startup work. Register the resulting flows only after that
    // read/import effect ends, under the original guarded handler context.
    const catalog = Layer.unwrap(Executable.catalog({ delegates: [RunPlan, atomDelegate, checkDelegate, ...(options.planning === undefined ? [] : [RunRequest])] }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.map(built => Layer.mergeAll(leaves, ...built.executables.map(entry => entry.layer)).pipe(
        Layer.provideMerge(Layer.succeed(Executable.Catalog, built))
      ))
    )).pipe(Layer.orDie)
    const modules = registration.pipe(Layer.provideMerge(catalog), Layer.tap(context => Effect.gen(function*() {
      const built = Context.get(context, Executable.Catalog)
      for (const [name, delegate] of [["coding", RunPlan._tag], ["coding/implementation", atomDelegate._tag],
        ...(options.planning === undefined ? [] : [["coding/request", RunRequest._tag]])]) {
        if (!built.executables.some(entry => entry.descriptor.name === name && entry.delegate === delegate)) {
          return yield* Effect.die(new Error(`Required coding executable ${name} is unavailable; inspect the catalog refusal`))
        }
      }
      // Plue's adapter verifies the owning workspace binding. A missing native
      // binary, incorrect repository binding or invalid receipt prevents serve.
      const binding = yield* Context.get(context, NativeCoding).read()
      if (binding.head.kind !== "resolved") return yield* Effect.die(new Error("Resolve native JJ conflicts before starting the configured coding host"))
    })), Layer.orDie)
    const host = native.layerHost({ root: options.repositoryPath }, modules)
    return Layer.effect(Serve.GatewayHost)(Effect.map(Serve.GatewayHost, gateway => ({
      launch: (health, bind, root) => gateway.launch({ ...health, gatewayId: options.gatewayId,
        capabilities: [...new Set([...(health.capabilities ?? []), "coding-plan/v1", ...(options.planning === undefined ? [] : ["coding-request/v1"])])] }, bind, root)
    }))).pipe(Layer.provideMerge(host))
  }).pipe(Effect.provide(platform.host))))
}

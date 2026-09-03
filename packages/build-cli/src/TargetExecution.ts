/**
 * The shared runtime for executing a target declaration's own Effect body.
 *
 * Specialized package-executor rules may use native implementations, while
 * every other target settles through this exact stack. The BUILD.ts executor
 * also uses it until that loader is removed.
 *
 * @since 0.1.0
 */
import { FlowEngine } from "@smthrs/engine"
import { Action, type Flow, Interpreter } from "@smthrs/flow"
import { ExecIrreversibleLive } from "@smthrs/targets/Changesets"
import { GenerateCheckLive } from "@smthrs/targets/Compose"
import { CheckDocsLive } from "@smthrs/targets/DocsParity"
import { ExecLive, type ToolEnvironment } from "@smthrs/targets/Exec"
import type * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { ExpandFilegroupLive } from "@smthrs/targets/Filegroup"
import { CheckFileLive, WriteFileLive } from "@smthrs/targets/GeneratedFile"
import { LlmReviewLive } from "@smthrs/targets/LlmLint"
import { ScaffoldPackageLive } from "@smthrs/targets/NewPackage"
import { SyncPackageJsonLive } from "@smthrs/targets/PackageJson"
import * as Target from "@smthrs/targets/Target"
import { CaptureOutputsLive } from "@smthrs/targets/ToolBuild"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import type * as Schema from "effect/Schema"
import * as NodePath from "node:path"
import { declaredToolchain, layerInstall, layerNonInteractiveNodeServices, layerPackageManager } from "./engine.ts"
import type * as Planner from "./Planner.ts"

type Executable = Flow.Flow<
  string,
  Schema.Struct<{}>,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  never
>

/**
 * Executes one target body in a fresh in-memory Flow runtime.
 *
 * @category execution
 * @since 0.1.0
 */
export const runTarget = (
  workspaceRoot: string,
  cacheDirectory: string,
  target: Target.AnyTarget,
  attrs: unknown,
  executionId: string,
  sensitiveEnv: ReadonlyArray<string>,
  packageName?: string | undefined,
  signal?: AbortSignal | undefined,
  nixEnvironment?: Planner.PlannedEnvironment | undefined,
  sandbox?: ExecSandbox.Request | undefined
): Promise<Exit.Exit<unknown, unknown>> => {
  const flow = target as unknown as Executable
  const environment: ToolEnvironment | undefined = nixEnvironment === undefined
    ? undefined
    : { path: nixEnvironment.path.join(NodePath.delimiter), variables: nixEnvironment.variables }
  const hostEnvironment: Readonly<Record<string, string | undefined>> = environment === undefined
    ? process.env
    : { ...process.env, ...environment.variables, PATH: environment.path }
  const runtime = Layer.mergeAll(
    layerInstall,
    ExecLive({ workspaceRoot, cacheDirectory, sensitiveEnv, environment, sandbox }),
    GenerateCheckLive({ workspaceRoot, cacheDirectory, sensitiveEnv, environment }),
    ExecIrreversibleLive({ workspaceRoot }),
    CaptureOutputsLive({ workspaceRoot, cacheDirectory }),
    ExpandFilegroupLive({ workspaceRoot, cacheDirectory }),
    WriteFileLive({ workspaceRoot }),
    CheckFileLive({ workspaceRoot }),
    CheckDocsLive({ workspaceRoot }),
    LlmReviewLive({ workspaceRoot, sensitiveEnv }),
    SyncPackageJsonLive({ workspaceRoot, cacheDirectory }),
    ScaffoldPackageLive({ workspaceRoot, packageName }),
    Target.layerNotImplemented,
    Interpreter.layer(flow)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(layerPackageManager(workspaceRoot, declaredToolchain(attrs), sensitiveEnv, hostEnvironment)),
    Layer.provideMerge(layerNonInteractiveNodeServices)
  )
  return Effect.runPromiseExit(
    flow.execute(attrs as {}, { executionId }).pipe(Effect.provide(runtime)),
    { signal }
  )
}

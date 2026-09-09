/** Private shared local control graph. Native hosts supply the existing engine and executor.
 * @since 1.0.0
 */
import type { Control, ControlExecutor } from "@smthrs/control"
import { ControlLive, ControlRuntime } from "@smthrs/control"
import type { Journal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import type { Registry } from "@smthrs/registry"
import { Layer } from "effect"
import type { Engine } from "../Application.ts"
import * as ExecutorOwnership from "../ExecutorOwnership.ts"

/** Composes local control with its owned executor and durable notification queue.
 * @since 1.0.0
 * @private
 */
export const layer = (
  registry: Layer.Layer<Registry.Registry>,
  engine: Engine,
  executor:
    | Layer.Layer<
      ControlExecutor.ControlExecutor,
      never,
      ControlRuntime.ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
    >
    | undefined
): Layer.Layer<Control.Control> =>
  Layer.merge((executor === undefined ? ControlLive.layer : ControlLive.layer.pipe(Layer.provide(executor))).pipe(
    Layer.provide([
      engine.runtime,
      engine.journal,
      // The real queue, over the same journal the control plane writes to.
      // `layerNoop` dropped every notification on the floor.
      NotificationQueue.layer.pipe(Layer.provide(engine.journal)),
      registry
    ])
  ), ExecutorOwnership.layer(executor !== undefined))

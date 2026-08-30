/**
 * Reserved system-flow identifiers projected by the command-line interface.
 *
 * @since 0.1.0
 */

/**
 * The projection metadata for one reserved system flow.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface SystemFlowEntry {
  readonly verb: string
  readonly flowId: `system/${string}`
  readonly projection: "procedure" | "systemFlow"
  readonly deployClass: boolean
  readonly planBearing: boolean
}

/**
 * The authoritative command-line verb to reserved-flow map.
 *
 * `gc` is the retention verb: it resolves `@smthrs/engine-store`'s `retain`
 * operation, which deletes aged terminal runs with their attempts, clock
 * deadlines, deferred completions, journal entries, and time-travel archive
 * rows. It is a procedure rather than a deploy-class system flow because it
 * takes no plan and bears no approval envelope; the deletion is gated by the
 * operator invoking it, and automatic retention stays opt-in.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const catalog = [
  { verb: "plan", flowId: "system/plan", projection: "procedure", deployClass: false, planBearing: false },
  { verb: "run", flowId: "system/run", projection: "procedure", deployClass: false, planBearing: false },
  { verb: "release", flowId: "system/release", projection: "systemFlow", deployClass: true, planBearing: true },
  { verb: "serve", flowId: "system/serve", projection: "systemFlow", deployClass: true, planBearing: true },
  { verb: "up", flowId: "system/up", projection: "systemFlow", deployClass: true, planBearing: true },
  { verb: "ls", flowId: "system/ls", projection: "procedure", deployClass: false, planBearing: false },
  { verb: "ps", flowId: "system/ps", projection: "procedure", deployClass: false, planBearing: false },
  { verb: "logs", flowId: "system/logs", projection: "procedure", deployClass: false, planBearing: false },
  { verb: "status", flowId: "system/status", projection: "procedure", deployClass: false, planBearing: false },
  { verb: "cancel", flowId: "system/cancel", projection: "procedure", deployClass: false, planBearing: false },
  { verb: "approve", flowId: "system/approve", projection: "procedure", deployClass: false, planBearing: false },
  { verb: "deny", flowId: "system/deny", projection: "procedure", deployClass: false, planBearing: false },
  { verb: "signal", flowId: "system/signal", projection: "procedure", deployClass: false, planBearing: false },
  { verb: "gc", flowId: "system/gc", projection: "procedure", deployClass: false, planBearing: false },
  { verb: "replay", flowId: "system/replay", projection: "systemFlow", deployClass: false, planBearing: false },
  { verb: "add", flowId: "system/add", projection: "systemFlow", deployClass: false, planBearing: true },
  { verb: "remove", flowId: "system/remove", projection: "systemFlow", deployClass: false, planBearing: true },
  { verb: "eject", flowId: "system/eject", projection: "systemFlow", deployClass: false, planBearing: true },
  { verb: "test", flowId: "system/test", projection: "systemFlow", deployClass: false, planBearing: false },
  { verb: "init", flowId: "system/init", projection: "systemFlow", deployClass: false, planBearing: true },
  { verb: "doctor", flowId: "system/doctor", projection: "systemFlow", deployClass: false, planBearing: false },
  { verb: "migrate", flowId: "system/migrate", projection: "systemFlow", deployClass: false, planBearing: true },
  { verb: "docs", flowId: "system/docs", projection: "systemFlow", deployClass: false, planBearing: false }
] as const satisfies ReadonlyArray<SystemFlowEntry>

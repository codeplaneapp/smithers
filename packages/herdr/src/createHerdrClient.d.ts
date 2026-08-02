import { f as HerdrClient$1, g as HerdrClientOptions$1, h as HerdrEvent$1, j as HerdrLogger$1, A as HerdrPingOptions$1, B as HerdrPong$1, G as HerdrSubscription$1, I as HerdrSubscriptionHandle$1 } from './HerdrClientOptions-CfjzN_zB.js';

/**
 * Normalize a herdr event name to its dotted namespace form so consumers can
 * match tolerantly. herdr emits snake_case kinds (`workspace_created`) that
 * differ from the dotted subscription `type` strings (`workspace.created`), and
 * at least one event (`pane.agent_status_changed`) already arrives dotted;
 * already-dotted names pass through unchanged.
 *
 * @param {string} name
 * @returns {string}
 */
declare function normalizeHerdrEventName(name: string): string;
/**
 * Create a herdr socket client. One short-lived connection per
 * `call()`/`tryCall()`; a dedicated long-lived, auto-reconnecting connection
 * per `subscribe()`.
 *
 * @param {HerdrClientOptions} [opts]
 * @returns {HerdrClient}
 */
declare function createHerdrClient(opts?: HerdrClientOptions): HerdrClient;
type HerdrClient = HerdrClient$1;
type HerdrClientOptions = HerdrClientOptions$1;
type HerdrLogger = HerdrLogger$1;
type HerdrPingOptions = HerdrPingOptions$1;
type HerdrEvent = HerdrEvent$1;
type HerdrSubscription = HerdrSubscription$1;
type HerdrSubscriptionHandle = HerdrSubscriptionHandle$1;
type HerdrPong = HerdrPong$1;

export { type HerdrClient, type HerdrClientOptions, type HerdrEvent, type HerdrLogger, type HerdrPingOptions, type HerdrPong, type HerdrSubscription, type HerdrSubscriptionHandle, createHerdrClient, normalizeHerdrEventName };

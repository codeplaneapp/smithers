/**
 * Additive v2 constructors. Existing JournalRecords writers retain their bytes
 * until a versioned writer cutover can supply complete lifecycle evidence.
 *
 * @since 1.0.0
 */

/**
 * Additive typed engine event constructors and decoders.
 *
 * @category events
 * @since 1.0.0
 */
export {
  attempt,
  attemptEventType,
  AttemptPayload,
  type Consumer,
  CurrentAttempt,
  decodeCurrentAttempt,
  decodeEntry,
  EventError,
  ExecutionLifecycle,
  Lineage,
  stateEvent,
  stateEventType,
  StatePayload,
  Wait
} from "@smthrs/journal/EngineEvent"

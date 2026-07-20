/**
 * Internal parent-to-child handoff for the exact stderr/stdout log opened by a
 * detached launcher. The child consumes and deletes it before starting a run.
 */
export const DETACHED_RUN_LOG_FILE_ENV = "SMITHERS_INTERNAL_DETACHED_LOG_FILE";

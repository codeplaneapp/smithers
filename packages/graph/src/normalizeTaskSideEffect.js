/**
 * Normalize the public boolean/object Task prop into the descriptor shape.
 *
 * @param {unknown} value
 * @returns {import("./TaskSideEffect.ts").TaskSideEffect | undefined}
 */
export function normalizeTaskSideEffect(value) {
    if (value === true) {
        return { idempotent: false };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const option = /** @type {{ idempotent?: unknown; revert?: unknown }} */ (value);
    return {
        idempotent: option.idempotent === true,
        ...(typeof option.revert === "function"
            ? { revert: /** @type {import("./TaskSideEffect.ts").TaskSideEffect["revert"]} */ (option.revert) }
            : {}),
    };
}

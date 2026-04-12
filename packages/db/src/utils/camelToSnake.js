/**
 * Converts a camelCase string to snake_case.
 */
export function camelToSnake(str) {
    return str.replace(/([A-Z])/g, "_$1").toLowerCase();
}

/**
 * @param {string} name
 * @returns {string}
 */
export function toPrometheusMetricName(name) {
    const next = name.replace(/[^a-zA-Z0-9_:]/g, "_");
    return /^[a-zA-Z_:]/.test(next) ? next : `_${next}`;
}

import * as BunContext from "@effect/platform-bun/BunContext";

/**
 * @typedef {import("effect").Layer.Layer<any, never, never>} PlatformLayer
 */

/** @type {PlatformLayer} */
const defaultPlatformLayer = BunContext.layer;
/** @type {PlatformLayer} */
let activePlatformLayer = defaultPlatformLayer;

/**
 * @returns {PlatformLayer}
 */
export function getDefaultPlatformLayer() {
    return defaultPlatformLayer;
}

/**
 * @returns {PlatformLayer}
 */
export function getPlatformLayer() {
    return activePlatformLayer;
}

/**
 * Inject a platform layer, such as NodeContext.layer from @effect/platform-node.
 * @param {PlatformLayer} layer
 */
export function setPlatformLayer(layer) {
    activePlatformLayer = layer;
}

export function resetPlatformLayer() {
    activePlatformLayer = defaultPlatformLayer;
}

/**
 * Temporarily use a platform layer while an async operation is running.
 * @template T
 * @param {PlatformLayer} layer
 * @param {() => T | Promise<T>} execute
 * @returns {Promise<T>}
 */
export async function withPlatformLayer(layer, execute) {
    const previous = activePlatformLayer;
    activePlatformLayer = layer;
    try {
        return await execute();
    }
    finally {
        activePlatformLayer = previous;
    }
}

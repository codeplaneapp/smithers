import { Effect } from "effect";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** @typedef {"bun" | "node"} EnginePlatformName */

let defaultPlatformLayerPromise;
let enginePlatformLayerOverride;

/**
 * @param {unknown} value
 * @returns {EnginePlatformName | null}
 */
function normalizePlatformName(value) {
    if (typeof value !== "string")
        return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "bun")
        return "bun";
    if (normalized === "node" || normalized === "nodejs")
        return "node";
    return null;
}

/**
 * @returns {EnginePlatformName}
 */
function selectDefaultPlatformName() {
    const env = typeof process !== "undefined" ? process.env : undefined;
    return (normalizePlatformName(env?.SMITHERS_PLATFORM) ??
        normalizePlatformName(env?.SMITHERS_ENGINE_PLATFORM) ??
        (typeof Bun === "undefined" ? "node" : "bun"));
}

/**
 * @param {EnginePlatformName} platform
 * @returns {Promise<unknown>}
 */
async function loadPlatformLayer(platform) {
    if (platform === "node") {
        const NodeContext = await import("@effect/platform-node/NodeContext");
        return NodeContext.layer;
    }
    const context = await import("@effect/platform-bun/" + "BunContext");
    return context.layer;
}

/**
 * @returns {Promise<unknown>}
 */
async function loadDefaultPlatformLayer() {
    return loadPlatformLayer(selectDefaultPlatformName());
}

/**
 * @param {unknown} layer
 */
export function setEnginePlatformLayerOverride(layer) {
    enginePlatformLayerOverride = layer;
}

export function clearEnginePlatformLayerOverride() {
    enginePlatformLayerOverride = undefined;
}

/**
 * Resolve the Effect platform layer used by engine VCS effects.
 *
 * @param {unknown} [layerOverride]
 * @returns {Promise<unknown>}
 */
export async function resolveEnginePlatformLayer(layerOverride) {
    const providedLayer = layerOverride ?? enginePlatformLayerOverride;
    if (providedLayer) {
        return providedLayer;
    }
    if (!defaultPlatformLayerPromise) {
        defaultPlatformLayerPromise = loadDefaultPlatformLayer();
    }
    return defaultPlatformLayerPromise;
}

/**
 * @template A
 * @template E
 * @template R
 * @param {Effect.Effect<A, E, R>} effect
 * @param {unknown} platformLayer
 * @returns {Effect.Effect<A, E, never>}
 */
export function runWithEnginePlatform(effect, platformLayer) {
    return effect.pipe(Effect.provide(platformLayer));
}

/**
 * @template A
 * @template E
 * @template R
 * @param {Effect.Effect<A, E, R>} effect
 * @param {unknown} [platformLayer]
 * @returns {Promise<A>}
 */
export async function runPromiseWithEnginePlatform(effect, platformLayer) {
    return Effect.runPromise(runWithEnginePlatform(effect, await resolveEnginePlatformLayer(platformLayer)));
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleepMs(ms) {
    const numericMs = Number(ms);
    const delayMs = Math.max(0, Number.isFinite(numericMs) ? numericMs : 0);
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isExecutable(path) {
    try {
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}

/**
 * @param {string} command
 * @returns {string[]}
 */
function commandCandidates(command) {
    if (typeof process === "undefined" || process.platform !== "win32") {
        return [command];
    }
    if (/\.[^\\/]+$/.test(command)) {
        return [command];
    }
    const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean);
    return extensions.map((extension) => `${command}${extension.startsWith(".") ? extension : `.${extension}`}`);
}

/**
 * @param {string} command
 * @returns {string | null}
 */
export function whichExecutable(command) {
    if (!command) {
        return null;
    }
    if (command.includes("/") || command.includes("\\")) {
        return isExecutable(command) ? command : null;
    }
    const bunRuntime = typeof Bun !== "undefined" ? Bun : undefined;
    const bunWhich = bunRuntime?.which;
    if (typeof bunWhich === "function") {
        try {
            return bunWhich(command) ?? null;
        }
        catch {
            return null;
        }
    }
    const env = typeof process !== "undefined" ? process.env : undefined;
    const pathValue = env?.PATH ?? "";
    for (const dir of pathValue.split(delimiter)) {
        if (!dir)
            continue;
        for (const candidate of commandCandidates(command)) {
            const path = join(dir, candidate);
            if (isExecutable(path)) {
                return path;
            }
        }
    }
    return null;
}

export const __platformLayerInternals = {
    clearDefaultPlatformLayerCache() {
        defaultPlatformLayerPromise = undefined;
    },
    loadPlatformLayer,
    normalizePlatformName,
    selectDefaultPlatformName,
};

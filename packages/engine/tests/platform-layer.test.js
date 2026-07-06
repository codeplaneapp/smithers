import { afterEach, describe, expect, test } from "bun:test";
import { Context, Layer } from "effect";
import {
    getDefaultPlatformLayer,
    getPlatformLayer,
    resetPlatformLayer,
    setPlatformLayer,
    withPlatformLayer,
} from "../src/platform-layer.js";

const TestService = Context.GenericTag("smithers/test/PlatformLayer");
const layer = Layer.succeed(TestService, "test");
const scopedLayer = Layer.succeed(TestService, "scoped");

afterEach(() => {
    resetPlatformLayer();
});

describe("platform layer", () => {
    test("defaults to the Bun platform layer and can be reset", () => {
        const defaultLayer = getDefaultPlatformLayer();
        expect(getPlatformLayer()).toBe(defaultLayer);

        setPlatformLayer(layer);
        expect(getPlatformLayer()).toBe(layer);

        resetPlatformLayer();
        expect(getPlatformLayer()).toBe(defaultLayer);
    });

    test("scopes a temporary platform layer", async () => {
        setPlatformLayer(layer);

        const result = await withPlatformLayer(scopedLayer, async () => {
            expect(getPlatformLayer()).toBe(scopedLayer);
            return "done";
        });

        expect(result).toBe("done");
        expect(getPlatformLayer()).toBe(layer);
    });
});
